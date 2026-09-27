import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { knowledgeDocs, shopifyStores, type KnowledgeDoc, type Tenant } from "../db/schema.js";

export type KnowledgeBase = {
  notes: string;
  /** Her soruda okunan kaynaklar (künye, politikalar, sayfalar). */
  core: KnowledgeDoc[];
  /** Sadece başlığı verilen, gerekince okunan hukuki metinler. */
  legal: KnowledgeDoc[];
};

const SOURCE_ORDER = { shop: 0, policy: 1, page: 2 } as Record<string, number>;

export const isEnabled = (d: Pick<KnowledgeDoc, "enabledOverride" | "autoEnabled">) => d.enabledOverride ?? d.autoEnabled;

/**
 * Shopify uygulaması kaldırıldıysa Shopify'dan gelen bilgiler güncelliğini yitirmiştir:
 * kullanılmaz (Shopify verileri 48 saat sonra shop/redact ile ayrıca silinir).
 */
async function shopifyDocsUsable(db: DB, tenantId: string): Promise<boolean> {
  const [store] = await db
    .select({ uninstalledAt: shopifyStores.uninstalledAt })
    .from(shopifyStores)
    .where(eq(shopifyStores.tenantId, tenantId));
  return !store?.uninstalledAt;
}

/**
 * Mağazanın etkin bilgi kaynakları; hiç yoksa null (bilgi uzmanı kapalı).
 * Mağaza notları Shopify'dan gelmediği için uygulama kaldırılsa da kullanılır.
 */
export async function loadKnowledge(db: DB, tenant: Tenant): Promise<KnowledgeBase | null> {
  const usable = await shopifyDocsUsable(db, tenant.id);
  const docs = (usable ? await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenant.id)) : [])
    .filter(isEnabled)
    // Sıra sabit olmalı: sistem istemi değişmezse önbellekten okunur.
    .sort((a, b) => SOURCE_ORDER[a.source]! - SOURCE_ORDER[b.source]! || a.title.localeCompare(b.title, "tr"));
  const kb = {
    notes: tenant.notes.trim(),
    core: docs.filter((d) => d.kind === "core"),
    legal: docs.filter((d) => d.kind === "legal"),
  };
  return kb.notes || kb.core.length || kb.legal.length ? kb : null;
}

export async function readLegalDoc(db: DB, tenantId: string, docId: string): Promise<KnowledgeDoc | null> {
  if (!(await shopifyDocsUsable(db, tenantId))) return null;
  const [doc] = await db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.tenantId, tenantId), eq(knowledgeDocs.id, docId), eq(knowledgeDocs.kind, "legal")));
  return doc && isEnabled(doc) ? doc : null;
}
