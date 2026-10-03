import type { NextFunction, Request, Response, Router } from "express";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { proposeLessons, type TestTurn } from "../agents/trainer.js";
import { describeLlmError } from "../agents/runner.js";
import type { Deps } from "../core/conversation.js";
import { MAX_LESSON_LENGTH, MAX_LESSONS } from "../core/lessons.js";
import type { DB } from "../db/client.js";
import { lessons, tenants, users, type MemberRole } from "../db/schema.js";
import { isUuid, param, type Locals } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

const isTurn = (t: unknown): t is TestTurn =>
  Boolean(t) &&
  ((t as TestTurn).role === "user" || (t as TestTurn).role === "assistant") &&
  typeof (t as TestTurn).text === "string" &&
  (t as TestTurn).text.length <= 4000;

const cleanText = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Lina'yı eğitmek (docs/lina-davranis.md "Lina'yı eğitmek"): mağaza sahibi test ekranında
 * "geri bildirim: ..." yazar, eğitmen bunu kurallara çevirir, sahip onaylayınca ders olarak kaydedilir.
 * Dersler bütün konuşmalarda (WhatsApp dahil) hemen geçerlidir. Yalnızca mağaza sahibi.
 */
export function registerLessonRoutes(
  api: Router,
  deps: { db: DB; simulatorDeps?: Deps; log: Pick<Console, "error"> },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const { db } = deps;
  const owner = [guards.requireUser, guards.requireTenant("owner")];

  api.post("/tenants/:tenantId/test/feedback", ...owner, async (req, res) => {
    if (!deps.simulatorDeps) return res.status(503).json({ error: "Geri bildirim şu an değerlendirilemiyor" });
    const feedback = cleanText(req.body?.feedback);
    const conversation = req.body?.history;
    if (!feedback || feedback.length > 4000 || !Array.isArray(conversation) || conversation.length > 40 || !conversation.every(isTurn)) {
      return res.status(400).json({ error: "Geri bildirim boş ya da çok uzun." });
    }
    const tenantId = param(req, "tenantId");
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) return res.status(404).json({ error: "Mağaza bulunamadı" });
    const existing = await db.select({ id: lessons.id, text: lessons.text }).from(lessons).where(eq(lessons.tenantId, tenantId));
    try {
      const { llm, model } = deps.simulatorDeps;
      res.json(await proposeLessons(llm, model, db, tenant, conversation, feedback, existing));
    } catch (err) {
      deps.log.error("Geri bildirim değerlendirilemedi", err);
      res.status(502).json({ error: `Geri bildirim değerlendirilemedi (${describeLlmError(err)}). Tekrar deneyin.` });
    }
  });

  api.get("/tenants/:tenantId/lessons", ...owner, async (req, res) => {
    const rows = await db
      .select({ id: lessons.id, text: lessons.text, source: lessons.source, feedback: lessons.feedback, createdAt: lessons.createdAt, createdBy: users.name })
      .from(lessons)
      .leftJoin(users, eq(users.id, lessons.createdBy))
      .where(eq(lessons.tenantId, param(req, "tenantId")))
      .orderBy(asc(lessons.createdAt), asc(lessons.id));
    res.json({ lessons: rows });
  });

  /** Onaylanan kuralları kaydeder; yerine geçtikleri eski dersler aynı anda silinir. */
  api.post("/tenants/:tenantId/lessons", ...owner, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const texts: unknown = req.body?.texts;
    const replaces: unknown = req.body?.replaces ?? [];
    if (
      !Array.isArray(texts) ||
      texts.length < 1 ||
      texts.length > 5 ||
      !texts.every((t) => cleanText(t) && cleanText(t).length <= MAX_LESSON_LENGTH) ||
      !Array.isArray(replaces) ||
      !replaces.every((id) => typeof id === "string" && isUuid(id))
    ) {
      return res.status(400).json({ error: `Her kural boş olmamalı ve en fazla ${MAX_LESSON_LENGTH} karakter olmalı.` });
    }
    const feedback = cleanText(req.body?.feedback).slice(0, 4000) || null;
    // team: test ekranında "Lina soruyor" cevabından öğretilen bilgi.
    const source = req.body?.source === "team" ? ("team" as const) : ("feedback" as const);
    const userId = (res.locals as Locals).user!.id;
    const saved = await db.transaction(async (tx) => {
      if (replaces.length) {
        await tx.delete(lessons).where(and(eq(lessons.tenantId, tenantId), inArray(lessons.id, replaces as string[])));
      }
      const [{ n }] = (await tx.select({ n: count() }).from(lessons).where(eq(lessons.tenantId, tenantId))) as [{ n: number }];
      if (n + texts.length > MAX_LESSONS) return null;
      return tx
        .insert(lessons)
        .values(texts.map((t) => ({ tenantId, text: cleanText(t), source, feedback, createdBy: userId })))
        .returning({ id: lessons.id, text: lessons.text });
    });
    if (!saved) return res.status(409).json({ error: `En fazla ${MAX_LESSONS} ders kaydedilebilir; önce eskileri silin.` });
    res.status(201).json({ lessons: saved });
  });

  /** Dersi düzenle: metin değişir, kimliği ve tarihi kalır. */
  api.patch("/tenants/:tenantId/lessons/:lessonId", ...owner, async (req, res) => {
    const lessonId = param(req, "lessonId");
    const text = cleanText(req.body?.text);
    if (!isUuid(lessonId)) return res.status(404).json({ error: "Ders bulunamadı" });
    if (!text || text.length > MAX_LESSON_LENGTH) {
      return res.status(400).json({ error: `Ders boş olmamalı ve en fazla ${MAX_LESSON_LENGTH} karakter olmalı.` });
    }
    const updated = await db
      .update(lessons)
      .set({ text })
      .where(and(eq(lessons.tenantId, param(req, "tenantId")), eq(lessons.id, lessonId)))
      .returning({ id: lessons.id, text: lessons.text });
    if (!updated.length) return res.status(404).json({ error: "Ders bulunamadı" });
    res.json({ lesson: updated[0] });
  });

  api.delete("/tenants/:tenantId/lessons/:lessonId", ...owner, async (req, res) => {
    const lessonId = param(req, "lessonId");
    if (!isUuid(lessonId)) return res.status(404).json({ error: "Ders bulunamadı" });
    const deleted = await db
      .delete(lessons)
      .where(and(eq(lessons.tenantId, param(req, "tenantId")), eq(lessons.id, lessonId)))
      .returning({ id: lessons.id });
    if (!deleted.length) return res.status(404).json({ error: "Ders bulunamadı" });
    res.json({ ok: true });
  });
}
