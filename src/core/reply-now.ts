import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { conversations, resolveSettings, tenants, type Tenant } from "../db/schema.js";

/**
 * "Şimdi cevapla" istekleri (settings.replyNow): bu mağazanın konuşmalarından cevap verilmesi istenenleri alır ve listeyi boşaltır.
 * Başka mağazaya ait kimlikler yok sayılır. Dönen konuşmalar zamanlayıcıya verilir (respond() gerekli kontrolleri yapar).
 */
export async function takeReplyRequests(db: DB, tenant: Tenant): Promise<string[]> {
  const [fresh] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenant.id));
  const settings = resolveSettings(fresh?.settings);
  if (!settings.replyNow.length) return [];
  await db.update(tenants).set({ settings: { ...settings, replyNow: [] } }).where(eq(tenants.id, tenant.id));
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenant.id), inArray(conversations.id, settings.replyNow)));
  return rows.map((r) => r.id);
}
