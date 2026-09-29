import { eq, isNotNull } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { shopifyStores, tenants, type Tenant } from "../db/schema.js";
import { recordSnapshot, refreshCampaignDoc, type RecordResult } from "./archive.js";
import { fetchSiteTexts, fetchStorefrontProducts } from "./storefront.js";

export type ArchiveRun = { products?: RecordResult; site?: RecordResult; errors: string[] };

type Options = { fetch?: typeof fetch; now?: () => Date };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Bir mağazanın ürün ve site yazılarını o anki haliyle arşive işler (docs/lina-davranis.md
 * "Kampanya yazıları"). Bir kaynağın hatası diğerini durdurmaz.
 */
export async function archiveTenant(db: DB, tenant: Tenant, opts: Options = {}): Promise<ArchiveRun> {
  const domain = tenant.domain;
  if (!domain) throw new Error(`${tenant.slug}: mağaza adresi (domain) tanımlı değil`);
  const now = opts.now ?? (() => new Date());
  const run: ArchiveRun = { errors: [] };
  try {
    const items = await fetchStorefrontProducts(domain, opts.fetch);
    run.products = await recordSnapshot(db, tenant.id, "product", items, now());
  } catch (err) {
    run.errors.push(`ürünler: ${message(err)}`);
  }
  try {
    const site = await fetchSiteTexts(domain, opts.fetch);
    run.site = await recordSnapshot(db, tenant.id, "site", site.items, now(), { allowEmpty: site.authoritative });
  } catch (err) {
    run.errors.push(`site: ${message(err)}`);
  }
  // Mağaza bilgi uzmanının "güncel kampanyalar" kaynağı.
  try {
    await refreshCampaignDoc(db, tenant.id);
  } catch (err) {
    run.errors.push(`kampanya özeti: ${message(err)}`);
  }
  return run;
}

export function describeRun(run: ArchiveRun): string {
  const part = (name: string, r?: RecordResult) =>
    r && `${name}: ${r.added} yeni, ${r.changed} değişen, ${r.unchanged} aynı, ${r.ended} kalkan`;
  return [part("ürünler", run.products), part("site", run.site)].filter(Boolean).join(" · ");
}

/**
 * Adresi olan bütün mağazaları sırayla arşivler. Shopify uygulamasını kaldıran mağaza atlanır:
 * verileri 48 saat içinde silinecek, yenisi toplanmaz.
 */
export async function archiveAllTenants(db: DB, log: Pick<Console, "info" | "error">, opts: Options = {}) {
  const rows = await db
    .select({ tenant: tenants, uninstalledAt: shopifyStores.uninstalledAt })
    .from(tenants)
    .leftJoin(shopifyStores, eq(shopifyStores.tenantId, tenants.id))
    .where(isNotNull(tenants.domain));
  for (const { tenant, uninstalledAt } of rows) {
    if (!tenant.domain || uninstalledAt) continue;
    try {
      const run = await archiveTenant(db, tenant, opts);
      const r = [run.products, run.site];
      if (r.some((x) => x && (x.added || x.changed || x.ended))) log.info(`[${tenant.slug}] arşiv: ${describeRun(run)}`);
      for (const e of run.errors) log.error(`[${tenant.slug}] arşiv hatası: ${e}`);
    } catch (err) {
      log.error(`[${tenant.slug}] arşiv başarısız`, err);
    }
  }
}
