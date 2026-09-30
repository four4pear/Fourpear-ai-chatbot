import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { shopifyStores, type ShopifyStore } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { refreshAccessToken, type ShopifyAppCredentials, type ShopifyTokenResponse } from "./oauth.js";

/** Mağazaya GraphQL sorgusu atan arayüz; testlerde sahtesi kullanılır. */
export interface ShopifyApi {
  graphql<T>(store: ShopifyStore, query: string, variables?: Record<string, unknown>): Promise<T>;
}

export class ShopifyApiError extends Error {
  /** Geçici hata mı (yoğunluk, sunucu hatası); tekrar denenebilir. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Token alanlarını şifreleyip veritabanı sütunlarına çevirir. */
export function tokenColumns(token: ShopifyTokenResponse, masterKey: string, now = new Date()) {
  return {
    scopes: token.scope,
    accessTokenEnc: encryptSecret(token.access_token, masterKey),
    accessTokenExpiresAt: token.expires_in ? new Date(now.getTime() + token.expires_in * 1000) : null,
    refreshTokenEnc: token.refresh_token ? encryptSecret(token.refresh_token, masterKey) : null,
    refreshTokenExpiresAt: token.refresh_token_expires_in
      ? new Date(now.getTime() + token.refresh_token_expires_in * 1000)
      : null,
  };
}

/**
 * Admin GraphQL istemcisi. Süreli token'ı dolmasına 5 dk kala (ya da 401 alınca) yeniler
 * ve yeni token'ları kaydeder.
 */
export function createShopifyApi(opts: {
  db: DB;
  masterKey: string;
  /** Mağazanın bağlandığı uygulama (token yenilemek için; bkz. shopify/apps.ts). */
  appFor: (tenantId: string) => Promise<ShopifyAppCredentials | null>;
  apiVersion: string;
  /** Tekrar denemeler arası temel bekleme (1., 2. denemeden sonra 1x, 2x). Testlerde kısaltılır. */
  retryDelayMs?: number;
}): ShopifyApi {
  const { db, masterKey } = opts;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  // Aynı mağaza için eşzamanlı yenilemeleri tek isteğe indirir.
  const refreshing = new Map<string, Promise<string>>();

  async function refresh(store: ShopifyStore): Promise<string> {
    const pending = refreshing.get(store.id);
    if (pending) return pending;
    const task = (async () => {
      // Başka bir istek az önce yenilemiş olabilir: güncel kaydı oku.
      const [current] = await db.select().from(shopifyStores).where(eq(shopifyStores.id, store.id));
      if (!current?.refreshTokenEnc) throw new ShopifyApiError("Yenileme token'ı yok; mağazanın uygulamayı yeniden kurması gerekiyor");
      const app = await opts.appFor(current.tenantId);
      if (!app) throw new ShopifyApiError("Mağazanın Shopify uygulama anahtarları yok ('tenant shopify-app' ile girin)");
      const token = await refreshAccessToken(current.shopDomain, decryptSecret(current.refreshTokenEnc, masterKey), app);
      await db.update(shopifyStores).set(tokenColumns(token, masterKey)).where(eq(shopifyStores.id, store.id));
      return token.access_token;
    })().finally(() => refreshing.delete(store.id));
    refreshing.set(store.id, task);
    return task;
  }

  async function accessToken(store: ShopifyStore): Promise<string> {
    const [current] = await db.select().from(shopifyStores).where(eq(shopifyStores.id, store.id));
    if (!current || current.uninstalledAt) throw new ShopifyApiError("Mağazada uygulama kurulu değil");
    const expiresSoon = current.accessTokenExpiresAt && current.accessTokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000;
    return expiresSoon ? refresh(current) : decryptSecret(current.accessTokenEnc, masterKey);
  }

  async function call(store: ShopifyStore, token: string, query: string, variables?: Record<string, unknown>) {
    return fetch(`https://${store.shopDomain}/admin/api/${opts.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
  }

  /** Tek deneme: 401'de token'ı yenileyip bir kez daha dener. */
  async function attempt<T>(store: ShopifyStore, query: string, variables?: Record<string, unknown>): Promise<T> {
    let res = await call(store, await accessToken(store), query, variables);
    if (res.status === 401) res = await call(store, await refresh(store), query, variables);

    const text = await res.text();
    let body: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] };
    try {
      body = JSON.parse(text);
    } catch {
      // Ör. bakım ya da ağ geçidi hatasında HTML sayfa döner.
      throw new ShopifyApiError(`Shopify beklenmeyen cevap döndü (${res.status}): ${text.slice(0, 200)}`, {
        retryable: res.status === 429 || res.status >= 500,
        retryAfterMs: retryAfter(res),
      });
    }

    const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED") ?? false;
    if (!res.ok || body.errors) {
      const detail = body.errors?.map((e) => e.message).join("; ") || text.slice(0, 200);
      throw new ShopifyApiError(`Shopify GraphQL hatası (${res.status}): ${detail}`, {
        retryable: throttled || res.status === 429 || res.status >= 500,
        retryAfterMs: retryAfter(res),
      });
    }
    return body.data as T;
  }

  return {
    async graphql<T>(store: ShopifyStore, query: string, variables?: Record<string, unknown>): Promise<T> {
      for (let i = 1; ; i++) {
        try {
          return await attempt<T>(store, query, variables);
        } catch (err) {
          // Bağlantı hataları (fetch TypeError) da geçicidir.
          const retryable = err instanceof ShopifyApiError ? err.retryable : err instanceof TypeError;
          if (!retryable || i >= MAX_ATTEMPTS) throw err;
          const wait = (err instanceof ShopifyApiError && err.retryAfterMs) || retryDelayMs * i;
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    },
  };
}

const MAX_ATTEMPTS = 3;

/** Shopify 429'da Retry-After (saniye) başlığıyla ne kadar bekleneceğini söyler. */
function retryAfter(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return seconds > 0 ? Math.min(seconds, 30) * 1000 : undefined;
}
