import { createHash } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, isNull, lte } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { knowledgeDocs, textArchive, type ArchiveData, type ArchiveKind, type ArchivedText } from "../db/schema.js";
import { specialLines } from "../orders/facts.js";

/**
 * Kampanya arşivi (docs/lina-davranis.md "Kampanya yazıları"). Mağazanın ürün ve site yazıları
 * tarihli sürümler olarak saklanır: kampanya bitip yazı ürünlerden silinse de, kampanya döneminde
 * verilen siparişler için o tarihteki yazı bulunur.
 */

/** Bir anda görülen tek bir ürün ya da site yazısı. */
export type TextSnapshot = { ref: string; title: string; content: string; data: ArchiveData };

/** added: yeni ürün/bölüm · changed: yazısı değişti (eski sürüm kaldı) · ended: artık görünmüyor */
export type RecordResult = { added: number; changed: number; unchanged: number; ended: number };

function hashOf(s: TextSnapshot): string {
  return createHash("sha256").update(JSON.stringify([s.title, s.content, s.data])).digest("hex");
}

/**
 * Bir mağazanın o an görülen bütün ürünlerini (ya da site yazılarını) arşive işler:
 * - değişmeyen yazının yalnızca "son görülme" zamanı ilerler,
 * - değişen yazının eski sürümü bitiş tarihiyle kalır, yenisi açılır,
 * - artık görünmeyen ürün/bölümün sürümü silinmez, kapanır.
 * Boş liste hiçbir şeyi kapatmaz (bir çekme hatası bütün arşivi "kalktı" diye işaretlemesin);
 * `allowEmpty`: sayfa sağlam okundu ve gerçekten hiç yazı yok (ör. bütün kampanya afişleri kaldırıldı).
 * Zaman sırası korunur: arşivdeki son kayıttan eski bir kopya işlenmez.
 */
export async function recordSnapshot(
  db: DB,
  tenantId: string,
  kind: ArchiveKind,
  items: TextSnapshot[],
  seenAt: Date,
  opts: { allowEmpty?: boolean } = {},
): Promise<RecordResult> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(textArchive)
      .where(and(eq(textArchive.tenantId, tenantId), eq(textArchive.kind, kind), isNull(textArchive.endedAt)));
    const newest = current.reduce((max, c) => Math.max(max, c.lastSeenAt.getTime()), 0);
    if (seenAt.getTime() < newest) {
      throw new Error(`Arşivde ${new Date(newest).toISOString()} tarihli daha yeni kayıt var; eski kopya işlenemez`);
    }

    const byRef = new Map(current.map((c) => [c.ref, c]));
    // Aynı ürün iki kez gelirse (sayfalar arası kayma) sonuncusu geçerli.
    const seen = new Map(items.map((item) => [item.ref, item]));
    const result: RecordResult = { added: 0, changed: 0, unchanged: 0, ended: 0 };
    const stillSame: string[] = [];

    for (const item of seen.values()) {
      const hash = hashOf(item);
      const old = byRef.get(item.ref);
      if (old?.hash === hash) {
        stillSame.push(old.id);
        result.unchanged++;
        continue;
      }
      if (old) {
        await tx.update(textArchive).set({ endedAt: seenAt }).where(eq(textArchive.id, old.id));
        result.changed++;
      } else {
        result.added++;
      }
      await tx.insert(textArchive).values({ tenantId, kind, ...item, hash, firstSeenAt: seenAt, lastSeenAt: seenAt });
    }
    if (stillSame.length) {
      await tx.update(textArchive).set({ lastSeenAt: seenAt }).where(inArray(textArchive.id, stillSame));
    }

    if (seen.size || opts.allowEmpty) {
      const gone = current.filter((c) => !seen.has(c.ref));
      if (gone.length) {
        await tx.update(textArchive).set({ endedAt: seenAt }).where(inArray(textArchive.id, gone.map((c) => c.id)));
        result.ended = gone.length;
      }
    }
    return result;
  });
}

export type TextAt = {
  version: ArchivedText;
  /** Yazı bu tarihte gerçekten görüldü (ilk ve son görülme arasında). Değilse "bilinen son yazı". */
  confirmed: boolean;
  /** Tarih arşivin başlangıcından önce: elde en eski kopya var, o tarihte geçerli olduğu kesin değil. */
  beforeArchive: boolean;
};

/** Verilen tarihte (ör. sipariş tarihi) geçerli olan sürüm; arşivde hiç yoksa null. */
export async function textAt(db: DB, tenantId: string, kind: ArchiveKind, ref: string, at: Date): Promise<TextAt | null> {
  const scope = and(eq(textArchive.tenantId, tenantId), eq(textArchive.kind, kind), eq(textArchive.ref, ref));
  const [version] = await db
    .select()
    .from(textArchive)
    .where(and(scope, lte(textArchive.firstSeenAt, at)))
    .orderBy(desc(textArchive.firstSeenAt))
    .limit(1);
  if (version) return { version, confirmed: at.getTime() <= version.lastSeenAt.getTime(), beforeArchive: false };

  const [earliest] = await db.select().from(textArchive).where(scope).orderBy(asc(textArchive.firstSeenAt)).limit(1);
  return earliest ? { version: earliest, confirmed: false, beforeArchive: true } : null;
}

/** Güncel sürümler (ör. sitenin şu anki kampanya yazıları). */
export async function currentTexts(db: DB, tenantId: string, kind: ArchiveKind): Promise<ArchivedText[]> {
  return db
    .select()
    .from(textArchive)
    .where(and(eq(textArchive.tenantId, tenantId), eq(textArchive.kind, kind), isNull(textArchive.endedAt)))
    .orderBy(asc(textArchive.title));
}

/**
 * Güncel kampanya özeti: sitenin görünen yazıları ve ürün açıklamalarında ortak geçen koşul satırları
 * (en az iki üründe). Mağaza bilgi uzmanı "kampanya ne zaman bitiyor?", "kargo ücretsiz mi?" gibi
 * genel soruları bununla cevaplar; siparişe özel kural sipariş uzmanındadır (sipariş tarihindeki yazı).
 */
export function campaignDigest(site: Pick<ArchivedText, "content">[], products: Pick<ArchivedText, "content">[]): string | null {
  const lines: string[] = [];
  if (site.length) {
    lines.push("Sitenin görünen yazıları (üst bant, ana sayfa):");
    for (const s of site) lines.push(`- ${s.content.replace(/\s+/g, " ").trim()}`);
  }
  const counts = new Map<string, number>();
  for (const p of products) for (const line of new Set(specialLines(p.content))) counts.set(line, (counts.get(line) ?? 0) + 1);
  const shared = [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "tr"))
    .slice(0, 15);
  if (shared.length) {
    if (lines.length) lines.push("");
    lines.push("Ürün açıklamalarında ortak geçen kampanya ve koşul yazıları (bugünkü haliyle):");
    for (const [line, n] of shared) lines.push(`- ${line} (${n} üründe)`);
  }
  return lines.length ? lines.join("\n") : null;
}

/** Kampanya özetini mağazanın bilgi kaynaklarına yazar (özet yoksa kaldırır). */
export async function refreshCampaignDoc(db: DB, tenantId: string): Promise<void> {
  const [site, products] = await Promise.all([currentTexts(db, tenantId, "site"), currentTexts(db, tenantId, "product")]);
  const content = campaignDigest(site, products);
  const key = and(eq(knowledgeDocs.tenantId, tenantId), eq(knowledgeDocs.source, "campaign"), eq(knowledgeDocs.externalId, "digest"));
  if (!content) {
    await db.delete(knowledgeDocs).where(key);
    return;
  }
  const [existing] = await db.select().from(knowledgeDocs).where(key);
  if (existing?.content === content) return;
  const values = { title: "Güncel kampanya ve duyuru yazıları", url: null, content, kind: "core" as const, autoEnabled: true };
  await db
    .insert(knowledgeDocs)
    .values({ tenantId, source: "campaign", externalId: "digest", ...values })
    .onConflictDoUpdate({
      target: [knowledgeDocs.tenantId, knowledgeDocs.source, knowledgeDocs.externalId],
      set: { ...values, syncedAt: new Date() },
    });
}

/** Başlığında verilen parça geçen ürünlerin bütün sürümleri, eskiden yeniye. */
export async function versionsByTitle(db: DB, tenantId: string, kind: ArchiveKind, titlePart: string): Promise<ArchivedText[]> {
  return db
    .select()
    .from(textArchive)
    .where(and(eq(textArchive.tenantId, tenantId), eq(textArchive.kind, kind), ilike(textArchive.title, `%${titlePart}%`)))
    .orderBy(asc(textArchive.title), asc(textArchive.firstSeenAt));
}
