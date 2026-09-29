import { eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { knowledgeDocs, shopifyStores, type KnowledgeKind, type ShopifyStore } from "../db/schema.js";
import type { ShopifyApi } from "../shopify/client.js";
import { htmlToText } from "./html.js";

const STORE_QUERY = `#graphql
query StoreKnowledge($after: String) {
  shop {
    name
    contactEmail
    primaryDomain { url }
    shopAddress { city country phone }
    updatedAt
    shopPolicies { type title url updatedAt body }
  }
  pages(first: 50, after: $after) {
    nodes { id title handle isPublished updatedAt body }
    pageInfo { hasNextPage endCursor }
  }
}`;

type StoreQueryResult = {
  shop: {
    name: string;
    contactEmail: string;
    primaryDomain: { url: string };
    shopAddress: { city: string | null; country: string | null; phone: string | null };
    updatedAt: string;
    shopPolicies: { type: string; title: string; url: string; updatedAt: string; body: string }[];
  };
  pages: {
    nodes: { id: string; title: string; handle: string; isPublished: boolean; updatedAt: string; body: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const CORE_POLICIES = new Set(["REFUND_POLICY", "SHIPPING_POLICY", "CONTACT_INFORMATION"]);
/** Başlığa/adrese göre hukuki metin sayılan sayfalar. */
const LEGAL_PAGE = /kvkk|aydınlatma|aydinlatma|gizlilik|sözleşme|sozlesme|privacy|terms|legal|yasal|çerez|cerez|cookie|kişisel veri|kisisel/i;
/** Bu kadar kısa sayfalar (form/favoriler gibi) otomatik olarak kullanılmaz. */
const MIN_CONTENT_CHARS = 20;

type DocInput = {
  source: "policy" | "page" | "shop";
  externalId: string;
  title: string;
  url: string | null;
  content: string;
  kind: KnowledgeKind;
  autoEnabled: boolean;
  shopifyUpdatedAt: Date | null;
};

export function classifyPage(title: string, handle: string, content: string): { kind: KnowledgeKind; autoEnabled: boolean } {
  return {
    kind: LEGAL_PAGE.test(`${title} ${handle}`) ? "legal" : "core",
    autoEnabled: content.length >= MIN_CONTENT_CHARS,
  };
}

export type SyncResult = { total: number; changed: number; removed: number };

/**
 * Mağazanın politikalarını, sayfalarını ve künyesini Shopify'dan çekip knowledge_docs'a yazar.
 * Mağazanın panelden yaptığı açma/kapama seçimi (enabledOverride) korunur.
 */
export async function syncStoreKnowledge(db: DB, shopify: ShopifyApi, store: ShopifyStore): Promise<SyncResult> {
  try {
    const docs: DocInput[] = [];
    let after: string | null = null;
    let shop: StoreQueryResult["shop"] | null = null;

    do {
      const data: StoreQueryResult = await shopify.graphql<StoreQueryResult>(store, STORE_QUERY, { after });
      shop ??= data.shop;
      for (const page of data.pages.nodes) {
        if (!page.isPublished) continue;
        const content = htmlToText(page.body);
        docs.push({
          source: "page",
          externalId: page.id,
          title: page.title,
          url: `${data.shop.primaryDomain.url}/pages/${page.handle}`,
          content,
          ...classifyPage(page.title, page.handle, content),
          shopifyUpdatedAt: new Date(page.updatedAt),
        });
      }
      after = data.pages.pageInfo.hasNextPage ? data.pages.pageInfo.endCursor : null;
    } while (after);

    for (const policy of shop!.shopPolicies) {
      const content = htmlToText(policy.body);
      docs.push({
        source: "policy",
        externalId: policy.type,
        title: policy.title,
        url: policy.url,
        content,
        kind: CORE_POLICIES.has(policy.type) ? "core" : "legal",
        autoEnabled: content.length > 0,
        shopifyUpdatedAt: new Date(policy.updatedAt),
      });
    }

    const address = [shop!.shopAddress.city, shop!.shopAddress.country].filter(Boolean).join(", ");
    docs.push({
      source: "shop",
      externalId: "shop",
      title: "Mağaza künyesi",
      url: shop!.primaryDomain.url,
      content: [
        `Mağaza: ${shop!.name}`,
        `Web sitesi: ${shop!.primaryDomain.url}`,
        `E-posta: ${shop!.contactEmail}`,
        shop!.shopAddress.phone && `Telefon: ${shop!.shopAddress.phone}`,
        address && `Konum: ${address}`,
      ]
        .filter(Boolean)
        .join("\n"),
      kind: "core",
      autoEnabled: true,
      shopifyUpdatedAt: new Date(shop!.updatedAt),
    });

    const existing = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, store.tenantId));
    const byKey = new Map(existing.map((d) => [`${d.source}:${d.externalId}`, d]));
    let changed = 0;
    for (const doc of docs) {
      const old = byKey.get(`${doc.source}:${doc.externalId}`);
      const same =
        old &&
        old.content === doc.content &&
        old.title === doc.title &&
        old.kind === doc.kind &&
        old.autoEnabled === doc.autoEnabled &&
        old.url === doc.url;
      if (same) continue;
      changed++;
      await db
        .insert(knowledgeDocs)
        .values({ tenantId: store.tenantId, ...doc })
        .onConflictDoUpdate({
          target: [knowledgeDocs.tenantId, knowledgeDocs.source, knowledgeDocs.externalId],
          set: { ...doc, syncedAt: new Date() },
        });
    }

    // Shopify'da artık olmayan (silinen/yayından kaldırılan) içerikler. Kampanya özeti arşivden
    // gelir (archive/archive.ts), bu senkronun konusu değildir.
    const keep = docs.map((d) => `${d.source}:${d.externalId}`);
    const stale = existing.filter((d) => d.source !== "campaign" && !keep.includes(`${d.source}:${d.externalId}`));
    if (stale.length) await db.delete(knowledgeDocs).where(inArray(knowledgeDocs.id, stale.map((d) => d.id)));

    await db.update(shopifyStores).set({ lastSyncAt: new Date(), lastSyncError: null }).where(eq(shopifyStores.id, store.id));
    return { total: docs.length, changed, removed: stale.length };
  } catch (err) {
    await db
      .update(shopifyStores)
      .set({ lastSyncError: err instanceof Error ? err.message : String(err) })
      .where(eq(shopifyStores.id, store.id));
    throw err;
  }
}

/** Kurulu tüm mağazaları sırayla senkronlar; bir mağazanın hatası diğerlerini durdurmaz. */
export async function syncAllStores(db: DB, shopify: ShopifyApi, log: Pick<Console, "info" | "error">) {
  const stores = await db.select().from(shopifyStores).where(isNull(shopifyStores.uninstalledAt));
  for (const store of stores) {
    try {
      const r = await syncStoreKnowledge(db, shopify, store);
      if (r.changed || r.removed) log.info(`[${store.shopDomain}] bilgi güncellendi: ${r.changed} değişen, ${r.removed} silinen`);
    } catch (err) {
      log.error(`[${store.shopDomain}] bilgi senkronu başarısız`, err);
    }
  }
}
