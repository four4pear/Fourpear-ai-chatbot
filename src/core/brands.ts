import { inArray } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { resolveSettings, tenants, type KnowledgeDoc, type Tenant } from "../db/schema.js";
import type { KnowledgeBase } from "../knowledge/base.js";
import { belongsTo, type OrderFacts, type OrderSource } from "../orders/types.js";
import type { ProductSource } from "../products/types.js";

/**
 * Çok markalı hat: aynı WhatsApp hattından birden çok mağazaya (markaya) hizmet verilir. Her mağaza kendi Shopify
 * bağlantısı, bilgileri ve arşiviyle ayrı kalır; ana mağazanın `linkedTenantIds` ayarındaki mağazalar Lina cevap
 * hazırlarken birlikte okunur. Konuşmalar, panel ve ekip ana mağazadadır.
 */

/** Ana mağaza (ilk) ve ona bağlı, var olan mağazalar; bağlı mağaza yoksa yalnızca ana mağaza. */
export async function loadBrands(db: DB, tenant: Tenant): Promise<Tenant[]> {
  const ids = resolveSettings(tenant.settings).linkedTenantIds.filter((id) => id !== tenant.id);
  if (!ids.length) return [tenant];
  const linked = new Map((await db.select().from(tenants).where(inArray(tenants.id, ids))).map((t) => [t.id, t]));
  // Sıra sabit olmalı (sistem istemi değişmezse önbellekten okunur): ayardaki sıra.
  return [tenant, ...ids.flatMap((id) => linked.get(id) ?? [])];
}

/** Lina'ya "bu hat şu markalara hizmet veriyor" diye yazılan ad: "MAIUS (maiusonline.com)". */
export const brandLabel = (t: Pick<Tenant, "name" | "domain">) => (t.domain ? `${t.name} (${t.domain})` : t.name);

/**
 * Markaların bilgi kaynaklarını tek bilgi tabanında birleştirir: belge başlıkları "[MAIUS] …" diye markayı taşır,
 * ana mağazanın notları hat geneli, bağlı mağazaların notları markaya özeldir. Tek markada kaynaklar olduğu gibi kalır.
 */
export function mergeKnowledge(parts: { tenant: Tenant; kb: KnowledgeBase | null }[]): KnowledgeBase | null {
  if (parts.length === 1) return parts[0]!.kb;
  const tag = (t: Tenant, d: KnowledgeDoc): KnowledgeDoc => ({ ...d, title: `[${t.name}] ${d.title}` });
  const notes = parts
    .flatMap(({ tenant, kb }, i) => (kb?.notes ? [i === 0 ? `Hat geneli (bütün markalar için): ${kb.notes}` : `[${tenant.name}] ${kb.notes}`] : []))
    .join("\n\n");
  const core = parts.flatMap(({ tenant, kb }) => kb?.core.map((d) => tag(tenant, d)) ?? []);
  const legal = parts.flatMap(({ tenant, kb }) => kb?.legal.map((d) => tag(tenant, d)) ?? []);
  return notes || core.length || legal.length ? { notes, core, legal } : null;
}

const firstFailure = (results: PromiseSettledResult<unknown>[]) => results.find((r): r is PromiseRejectedResult => r.status === "rejected");

/**
 * Markaların sipariş kaynaklarını birleştirir: sipariş numarası her markada aranır (aynı numara iki markada varsa
 * müşterinin telefonuna ait olan seçilir), telefonla arama bütün markaların siparişlerini getirir. Siparişe marka
 * yazılır. Bir marka hata verirse diğerinin bulduğu kullanılır; hiçbiri bulamayıp biri hata verdiyse hata yükselir
 * ("bulunamadı" denmesin, ekibe bildirim düşsün).
 */
export function compositeOrderSource(parts: { brand: string; source: OrderSource }[], waId: string): OrderSource {
  const tag = (brand: string, o: OrderFacts): OrderFacts => ({ ...o, brand });
  return {
    async byName(typed) {
      const results = await Promise.allSettled(parts.map((p) => p.source.byName(typed)));
      const found = results.flatMap((r, i) => (r.status === "fulfilled" && r.value ? [tag(parts[i]!.brand, r.value)] : []));
      if (found.length) return found.find((o) => belongsTo(o, waId)) ?? found[0]!;
      const failed = firstFailure(results);
      if (failed) throw failed.reason;
      return null;
    },
    async byPhone(phone) {
      const results = await Promise.allSettled(parts.map((p) => p.source.byPhone(phone)));
      const orders = results.flatMap((r, i) => (r.status === "fulfilled" ? r.value.map((o) => tag(parts[i]!.brand, o)) : []));
      if (!orders.length) {
        const failed = firstFailure(results);
        if (failed) throw failed.reason;
      }
      return orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}

/** Markaların ürün kaynaklarını birleştirir; ürünlere marka yazılır. Biri hata verirse diğerinin sonucu kullanılır. */
export function compositeProductSource(parts: { brand: string; source: ProductSource }[]): ProductSource {
  return {
    async search(query, limit = 5) {
      const results = await Promise.allSettled(parts.map((p) => p.source.search(query, limit)));
      const products = results.flatMap((r, i) => (r.status === "fulfilled" ? r.value.map((p) => ({ ...p, brand: parts[i]!.brand })) : []));
      if (!products.length) {
        const failed = firstFailure(results);
        if (failed) throw failed.reason;
      }
      return products.slice(0, Math.max(limit, 6));
    },
  };
}
