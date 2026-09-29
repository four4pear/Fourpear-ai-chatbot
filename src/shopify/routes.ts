import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { agentRuns, customers, knowledgeDocs, shopifyStores, tenants, textArchive, type ShopifyStore } from "../db/schema.js";
import { normalizePhone } from "../lib/phone.js";
import { tokenColumns, type ShopifyApi } from "./client.js";
import {
  authorizeUrl,
  createState,
  exchangeCode,
  isValidCallbackHmac,
  isValidShopDomain,
  readInstallToken,
  readState,
  type ShopifyAppCredentials,
} from "./oauth.js";

export type ShopifyRouteDeps = {
  db: DB;
  shopify: ShopifyApi;
  app: ShopifyAppCredentials;
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

export function registerShopifyRoutes(app: Express, deps: ShopifyRouteDeps) {
  const { db } = deps;
  const redirectUri = `${deps.appUrl}/shopify/callback`;

  /**
   * Kurulumu başlatır: /shopify/install?token=...
   * Token'ı yalnızca bizim araçlarımız üretir (createInstallToken; şimdilik `npm run tenant -- shopify-link`).
   */
  app.get("/shopify/install", async (req, res) => {
    const install = readInstallToken(String(req.query.token ?? ""), deps.app.apiSecret);
    if (!install) {
      res.status(400).send(page("Kurulum linki geçersiz", "Linkin süresi dolmuş ya da hatalı. Lütfen yeni bir kurulum linki isteyin."));
      return;
    }
    const { shop } = install;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, install.tenantId));
    if (!tenant) {
      res.status(404).send(page("Hesap bulunamadı", "Bu kurulum linkine ait hesap artık yok."));
      return;
    }
    const state = createState(tenant.id, shop, deps.app.apiSecret);
    res.redirect(authorizeUrl({ shop, apiKey: deps.app.apiKey, redirectUri, state }));
  });

  app.get("/shopify/callback", async (req, res) => {
    const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    const shop = (query.shop ?? "").toLowerCase();
    const state = isValidShopDomain(shop) ? readState(query.state ?? "", shop, deps.app.apiSecret) : null;
    if (!state || !query.code || !isValidCallbackHmac(query, deps.app.apiSecret)) {
      res.status(400).send(page("Kurulum doğrulanamadı", "Bağlantının süresi dolmuş olabilir; kurulumu yeniden başlatın."));
      return;
    }

    const [linked] = await db.select().from(shopifyStores).where(eq(shopifyStores.shopDomain, shop));
    if (linked && linked.tenantId !== state.tenantId) {
      res.status(409).send(page("Mağaza başka bir hesaba bağlı", "Bu Shopify mağazası başka bir hesapla kullanılıyor."));
      return;
    }

    try {
      const token = await (deps.exchange ?? exchangeCode)(shop, query.code, deps.app);
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
    if (!isValidWebhookHmac(raw, req.get("x-shopify-hmac-sha256"), deps.app.apiSecret)) {
      res.sendStatus(401);
      return;
    }
    const topic = req.get("x-shopify-topic") ?? "";
    const shop = (req.get("x-shopify-shop-domain") ?? "").toLowerCase();
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
