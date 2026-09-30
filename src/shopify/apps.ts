import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { integrations, shopifyStores } from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import type { ShopifyAppCredentials } from "./oauth.js";

/**
 * Hangi mağaza hangi Shopify uygulamasıyla bağlanır.
 *
 * App Store'a çıkmadan her mağaza kendi "özel dağıtım" (custom distribution) uygulamasıyla bağlanır;
 * Shopify bu uygulamayı tek mağazaya kilitler. Mağazanın uygulaması `shopify_app` bağlantısında
 * (Client ID + şifreli Client secret) durur. Sunucu ayarındaki SHOPIFY_API_KEY/SECRET ortak uygulamadır:
 * kendi uygulaması olmayan mağazalar onu kullanır (ileride App Store uygulaması).
 */
export type ShopifyApps = {
  forTenant(tenantId: string): Promise<ShopifyAppCredentials | null>;
  /** Shopify'ın mağaza adresiyle açtığı istekler (uygulamayı açma, bildirimler) hangi mağazamıza ait? */
  tenantForShop(shop: string): Promise<string | null>;
  shared?: ShopifyAppCredentials;
};

export function shopifyApps(db: DB, masterKey: string, shared?: ShopifyAppCredentials): ShopifyApps {
  const own = (tenantId: string) =>
    db
      .select()
      .from(integrations)
      .where(and(eq(integrations.tenantId, tenantId), eq(integrations.kind, "shopify_app"), eq(integrations.enabled, true)));

  return {
    shared,
    async forTenant(tenantId) {
      const [row] = await own(tenantId);
      if (row?.secretEnc && row.config.clientId) {
        return { apiKey: row.config.clientId, apiSecret: decryptSecret(row.secretEnc, masterKey) };
      }
      return shared ?? null;
    },
    async tenantForShop(shop) {
      const [store] = await db.select({ tenantId: shopifyStores.tenantId }).from(shopifyStores).where(eq(shopifyStores.shopDomain, shop));
      if (store) return store.tenantId;
      // Henüz kurulmamış mağaza: uygulaması hangi mağaza adresi için girildiyse.
      const [app] = await db
        .select({ tenantId: integrations.tenantId })
        .from(integrations)
        .where(and(eq(integrations.kind, "shopify_app"), eq(integrations.enabled, true), sql`${integrations.config}->>'shop' = ${shop}`));
      return app?.tenantId ?? null;
    },
  };
}

/** Kurulum linki ve OAuth state imzası: uygulamadan bağımsız, sunucunun ana anahtarından türetilir. */
export function oauthSigningKey(masterKey: string): string {
  return createHmac("sha256", masterKey).update("shopify-oauth").digest("base64url");
}
