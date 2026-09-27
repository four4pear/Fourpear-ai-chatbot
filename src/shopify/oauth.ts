import { createHmac, timingSafeEqual } from "node:crypto";

// Uygulamanın istediği izinler. Sipariş/ürün/müşteri izinleri Faz 2 ajanları için şimdiden
// isteniyor ki mağaza ikinci kez izin ekranından geçmesin.
export const SHOPIFY_SCOPES = [
  "read_legal_policies",
  "read_content",
  "read_online_store_pages",
  "read_products",
  "read_inventory",
  "read_orders",
  "read_fulfillments",
  "read_customers",
].join(",");

export type ShopifyAppCredentials = { apiKey: string; apiSecret: string };

export type ShopifyTokenResponse = {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

/**
 * İmzalı kısa ömürlü token: hangi mağaza hangi kiracıya bağlanacak.
 * "p" amacı ayırır; kurulum token'ı state yerine (ya da tersi) kullanılamaz.
 */
type SignedPayload = { p: "install" | "state"; t: string; s: string; exp: number };

const INSTALL_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function sign(data: SignedPayload, secret: string): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verify(token: string, purpose: SignedPayload["p"], secret: string, now: number): SignedPayload | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as SignedPayload;
  if (data.p !== purpose || now > data.exp || !isValidShopDomain(data.s)) return null;
  return data;
}

/**
 * Kurulum linki token'ı: yalnızca bizim araçlarımız (şimdilik CLI, ileride panel) üretir,
 * 24 saat geçerlidir. Mağaza kısa adını bilmek kurulum başlatmaya yetmez.
 */
export function createInstallToken(tenantId: string, shop: string, secret: string, now = Date.now()): string {
  return sign({ p: "install", t: tenantId, s: shop, exp: now + INSTALL_TTL_MS }, secret);
}

export function readInstallToken(token: string, secret: string, now = Date.now()): { tenantId: string; shop: string } | null {
  const data = verify(token, "install", secret, now);
  return data && { tenantId: data.t, shop: data.s };
}

/** OAuth state parametresi: Shopify'dan dönüşte aynı mağaza ve kiracıyı doğrular, 10 dk geçerli. */
export function createState(tenantId: string, shop: string, secret: string, now = Date.now()): string {
  return sign({ p: "state", t: tenantId, s: shop, exp: now + STATE_TTL_MS }, secret);
}

export function readState(state: string, shop: string, secret: string, now = Date.now()): { tenantId: string } | null {
  const data = verify(state, "state", secret, now);
  return data && data.s === shop ? { tenantId: data.t } : null;
}

export function authorizeUrl(opts: { shop: string; apiKey: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.apiKey,
    scope: SHOPIFY_SCOPES,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://${opts.shop}/admin/oauth/authorize?${params}`;
}

/** Shopify'ın geri dönüş (callback) sorgu parametrelerindeki hmac imzasını doğrular. */
export function isValidCallbackHmac(query: Record<string, string>, apiSecret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const expected = createHmac("sha256", apiSecret).update(message).digest("hex");
  return hmac.length === expected.length && timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
}

async function tokenRequest(shop: string, body: Record<string, string>): Promise<ShopifyTokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify token isteği başarısız (${res.status}): ${text}`);
  return JSON.parse(text) as ShopifyTokenResponse;
}

/** Yetkilendirme kodunu süreli (60 dk) offline token + yenileme token'ı ile değiştirir. */
export function exchangeCode(shop: string, code: string, app: ShopifyAppCredentials) {
  return tokenRequest(shop, { client_id: app.apiKey, client_secret: app.apiSecret, code, expiring: "1" });
}

export function refreshAccessToken(shop: string, refreshToken: string, app: ShopifyAppCredentials) {
  return tokenRequest(shop, {
    client_id: app.apiKey,
    client_secret: app.apiSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
