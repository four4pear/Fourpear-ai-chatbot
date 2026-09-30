import { asc, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { lessons } from "../db/schema.js";
import type { KnowledgeBase } from "../knowledge/base.js";

/** Bir mağazada en fazla bu kadar ders; sistem istemi şişmesin. */
export const MAX_LESSONS = 200;
export const MAX_LESSON_LENGTH = 1000;

/** Lina'nın mağazadan öğrendikleri, eskiden yeniye (sıra sabit: sistem istemi önbellekte kalır). */
export async function loadLessons(db: DB, tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ text: lessons.text })
    .from(lessons)
    .where(eq(lessons.tenantId, tenantId))
    .orderBy(asc(lessons.createdAt), asc(lessons.id));
  return rows.map((r) => r.text);
}

/**
 * Dersler uzmanlara (bilgi ve iade uzmanı) mağaza notlarıyla birlikte, öncelikli olarak gider.
 * Mağazanın hiç bilgi kaynağı yoksa da dersler kaybolmaz.
 */
export function withLessons(kb: KnowledgeBase | null, taught: string[]): KnowledgeBase | null {
  if (!taught.length) return kb;
  const block = `Mağazanın öğrettikleri (mağaza sahibi onayladı; kaynaklardan önce gelir):\n${taught.map((t) => `- ${t}`).join("\n")}`;
  const base = kb ?? { notes: "", core: [], legal: [] };
  return { ...base, notes: [base.notes, block].filter(Boolean).join("\n\n") };
}
