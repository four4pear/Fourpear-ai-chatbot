import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { agentRuns, customers, knowledgeDocs, shopifyStores, tenants, textArchive, type ShopifyStore } from "../db/schema.js";
import { normalizePhone } from "../lib/phone.js";
import { oauthSigningKey, type ShopifyApps } from "./apps.js";
import { tokenColumns, type ShopifyApi } from "./client.js";
import {
  authorizeUrl,
  createState,
  exchangeCode,
  isValidCallbackHmac,
  isValidShopDomain,
  readInstallToken,
  readState,
  SHOPIFY_SCOPES,
} from "./oauth.js";

export type ShopifyRouteDeps = {
  db: DB;
  shopify: ShopifyApi;
  /** Mağaza başına Shopify uygulaması (bkz. shopify/apps.ts). */
  apps: ShopifyApps;
  appUrl: string;
  masterKey: string;
  /** Kurulumdan hemen sonra mağaza bilgilerini çekmek için. */
  syncStore: (store: ShopifyStore) => Promise<unknown>;
  log: Pick<Console, "info" | "warn" | "error">;
  /** Test için değiştirilebilir. */
  exchange?: typeof exchangeCode;
};

const REGISTER_WEBHOOK = `#graphql
mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${body}</p></body>`;

export function isValidWebhookHmac(rawBody: Buffer, header: string | undefined, apiSecret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", apiSecret).update(rawBody).digest();
  const given = Buffer.from(header, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Mağaza, uygulamanın şu an istediği izinlerin hepsini vermiş mi? */
function hasAllScopes(granted: string): boolean {
  const have = new Set(granted.split(",").map((s) => s.trim()));
  return SHOPIFY_SCOPES.split(",").every((s) => have.has(s));
}

const queryOf = (query: Record<string, unknown>) => Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]));

export function registerShopifyRoutes(app: Express, deps: ShopifyRouteDeps) {
  const { db } = deps;
  const redirectUri = `${deps.appUrl}/shopify/callback`;
  const signingKey = oauthSigningKey(deps.masterKey);

  /**
   * Kurulumu başlatır. İki yoldan gelinir:
   * - Bizim imzalı linkimiz: /shopify/install?token=... (şimdilik `npm run tenant -- shopify-link`).
   * - Shopify: mağaza uygulamayı özel dağıtım linkiyle kurunca ya da yönetim panelinden açınca
   *   uygulama adresine ?shop=...&hmac=... ile gelir (Shopify'da App URL = <APP_URL>/shopify/install).
   */
  app.get("/shopify/install", async (req, res) => {
    const query = queryOf(req.query);
    let target: { tenantId: string; shop: string } | null = null;
    if (query.token) {
      target = readInstallToken(query.token, signingKey);
    } else if (query.shop && query.hmac) {
      const shop = query.shop.toLowerCase();
      const tenantId = isValidShopDomain(shop) ? await deps.apps.tenantForShop(shop) : null;
      if (!tenantId) {
        res.status(404).send(page("Hesap bulunamadı", "Bu Shopify mağazası için henüz bir Lina hesabı açılmamış. Lütfen bizimle iletişime geçin."));
        return;
      }
      const shopApp = await deps.apps.forTenant(tenantId);
      if (shopApp && isValidCallbackHmac(query, shopApp.apiSecret)) {
        target = { tenantId, shop };
        // Kurulu ve izinleri tamam: yönetim panelinden açılınca yeniden izin istemeye gerek yok.
        const [store] = await db.select().from(shopifyStores).where(eq(shopifyStores.shopDomain, shop));
        if (store && !store.uninstalledAt && store.tenantId === tenantId && hasAllScopes(store.scopes)) {
          res.send(page("Lina bu mağazaya bağlı", "Mağaza bilgileri düzenli olarak güncelleniyor. Bu pencereyi kapatabilirsiniz."));
          return;
        }
      }
    }
    if (!target) {
      res.status(400).send(page("Kurulum linki geçersiz", "Linkin süresi dolmuş ya da hatalı. Lütfen yeni bir kurulum linki isteyin."));
      return;
    }
    const { shop } = target;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, target.tenantId));
    if (!tenant) {
      res.status(404).send(page("Hesap bulunamadı", "Bu kurulum linkine ait hesap artık yok."));
      return;
    }
    const shopApp = await deps.apps.forTenant(tenant.id);
    if (!shopApp) {
      res.status(503).send(page("Kurulum hazır değil", "Bu hesap için Shopify uygulaması henüz ayarlanmamış. Lütfen bizimle iletişime geçin."));
      return;
    }
    const state = createState(tenant.id, shop, signingKey);
    res.redirect(authorizeUrl({ shop, apiKey: shopApp.apiKey, redirectUri, state }));
  });

  app.get("/shopify/callback", async (req, res) => {
    const query = queryOf(req.query);
    const shop = (query.shop ?? "").toLowerCase();
    const state = isValidShopDomain(shop) ? readState(query.state ?? "", shop, signingKey) : null;
    const shopApp = state ? await deps.apps.forTenant(state.tenantId) : null;
    if (!state || !shopApp || !query.code || !isValidCallbackHmac(query, shopApp.apiSecret)) {
      res.status(400).send(page("Kurulum doğrulanamadı", "Bağlantının süresi dolmuş olabilir; kurulumu yeniden başlatın."));
      return;
    }

    const [linked] = await db.select().from(shopifyStores).where(eq(shopifyStores.shopDomain, shop));
    if (linked && linked.tenantId !== state.tenantId) {
      res.status(409).send(page("Mağaza başka bir hesaba bağlı", "Bu Shopify mağazası başka bir hesapla kullanılıyor."));
      return;
    }

    try {
      const token = await (deps.exchange ?? exchangeCode)(shop, query.code, shopApp);
      const values = { ...tokenColumns(token, deps.masterKey), shopDomain: shop, installedAt: new Date(), uninstalledAt: null };
      const [store] = await db
        .insert(shopifyStores)
        .values({ tenantId: state.tenantId, ...values })
        .onConflictDoUpdate({ target: shopifyStores.tenantId, set: values })
        .returning();

      const result = await deps.shopify.graphql<{
        webhookSubscriptionCreate: { userErrors: { message: string }[] };
      }>(store!, REGISTER_WEBHOOK, { topic: "APP_UNINSTALLED", uri: `${deps.appUrl}/webhook/shopify` });
      const errors = result.webhookSubscriptionCreate.userErrors;
      // Yeniden kurulumda abonelik zaten var olabilir; bu bir hata değil.
      if (errors.length && !errors.some((e) => /already|taken/i.test(e.message))) {
        deps.log.warn(`[${shop}] webhook kaydı: ${errors.map((e) => e.message).join(", ")}`);
      }

      deps.syncStore(store!).catch((err) => deps.log.error(`[${shop}] ilk bilgi senkronu başarısız`, err));
      deps.log.info(`[${shop}] Shopify uygulaması kuruldu`);
      res.send(page("Kurulum tamamlandı", "Mağaza bilgileriniz aktarılıyor. Bu pencereyi kapatabilirsiniz."));
    } catch (err) {
      deps.log.error(`[${shop}] Shopify kurulumu başarısız`, err);
      res.status(502).send(page("Kurulum tamamlanamadı", "Shopify ile bağlantı kurulamadı; lütfen tekrar deneyin."));
    }
  });

  // Uygulama kaldırma ve Shopify'ın zorunlu gizlilik (GDPR) bildirimleri.
  app.post("/webhook/shopify", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const topic = req.get("x-shopify-topic") ?? "";
    const shop = (req.get("x-shopify-shop-domain") ?? "").toLowerCase();
    // Bildirim, mağazanın bağlandığı uygulamanın anahtarıyla imzalanır.
    const tenantId = isValidShopDomain(shop) ? await deps.apps.tenantForShop(shop) : null;
    const shopApp = tenantId ? await deps.apps.forTenant(tenantId) : deps.apps.shared;
    if (!shopApp || !isValidWebhookHmac(raw, req.get("x-shopify-hmac-sha256"), shopApp.apiSecret)) {
      res.sendStatus(401);
      return;
    }
    const payload = JSON.parse(raw.toString("utf8") || "{}") as { customer?: { phone?: string | null } };
    res.sendStatus(200);

    try {
      const [store] = await db.select().from(shopifyStores).where(eq(shopifyStores.shopDomain, shop));
      if (!store) return;

      if (topic === "app/uninstalled") {
        await db.update(shopifyStores).set({ uninstalledAt: new Date() }).where(eq(shopifyStores.id, store.id));
        deps.log.info(`[${shop}] uygulama kaldırıldı`);
      } else if (topic === "shop/redact") {
        // Kaldırmadan 48 saat sonra gelir: mağazanın Shopify'dan gelen verilerini sil (hepsi ya da hiçbiri).
        await db.transaction(async (tx) => {
          await tx.delete(knowledgeDocs).where(eq(knowledgeDocs.tenantId, store.tenantId));
          await tx.delete(textArchive).where(eq(textArchive.tenantId, store.tenantId));
          // Sipariş uzmanının kayıtları Shopify siparişlerinden türetilmiştir (konuşmalar mağazanın kaydı olarak kalır).
          await tx
            .update(agentRuns)
            .set({ input: null, output: null })
            .where(and(eq(agentRuns.tenantId, store.tenantId), eq(agentRuns.agent, "order")));
          await tx.delete(shopifyStores).where(eq(shopifyStores.id, store.id));
          // Kurulum kaydı silinince arşiv "hiç kurulmamış" sanıp vitrinden yeniden veri toplamasın.
          await tx.update(tenants).set({ domain: null }).where(eq(tenants.id, store.tenantId));
        });
        deps.log.info(`[${shop}] mağaza verileri silindi (shop/redact)`);
      } else if (topic === "customers/redact") {
        const phone = payload.customer?.phone;
        if (phone) {
          // Aynı telefonla yazan WhatsApp müşterisinin konuşmaları ve mesajları (cascade) silinir.
          await db
            .delete(customers)
            .where(and(eq(customers.tenantId, store.tenantId), eq(customers.waId, normalizePhone(phone))));
        }
        deps.log.info(`[${shop}] müşteri verisi silme talebi işlendi`);
      } else if (topic === "customers/data_request") {
        // Mağaza sahibine müşteri verisini iletmek için kayıt; panelde listelenecek (Faz 3).
        deps.log.warn(`[${shop}] müşteri veri talebi alındı: ${raw.toString("utf8")}`);
      }
    } catch (err) {
      deps.log.error(`[${shop}] Shopify bildirimi işlenemedi (${topic})`, err);
    }
  });
}
