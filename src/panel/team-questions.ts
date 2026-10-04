import type { NextFunction, Request, Response, Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { answerTeamQuestion } from "../core/team-questions.js";
import type { EventBus } from "../core/events.js";
import type { DB } from "../db/client.js";
import { conversations, customers, resolveSettings, teamQuestions, tenants, users, type MemberRole } from "../db/schema.js";
import { formatPhone } from "../lib/phone.js";
import { isUuid, param, type Locals } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Lina soruyor (docs/lina-davranis.md "Lina soruyor"): Lina'nın ekibe sorduğu sorular panelde listelenir;
 * mağazanın ekibi kısa bir cevap yazar, Lina müşteriye kendisi iletir. "Lina'ya öğret" (yalnızca
 * mağaza sahibi) cevabı ders olarak kaydeder; Lina aynı şeyi bir daha sormaz.
 */
export function registerTeamQuestionRoutes(
  api: Router,
  deps: { db: DB; events?: EventBus; triggerReply?: (conversationId: string) => void },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const { db } = deps;
  const member = [guards.requireUser, guards.requireTenant("agent")];

  api.get("/tenants/:tenantId/team-questions", ...member, async (req, res) => {
    const status = req.query.status === "answered" ? "answered" : "open";
    const rows = await db
      .select({ q: teamQuestions, customer: customers, answeredBy: users.name })
      .from(teamQuestions)
      .innerJoin(conversations, eq(conversations.id, teamQuestions.conversationId))
      .innerJoin(customers, eq(customers.id, conversations.customerId))
      .leftJoin(users, eq(users.id, teamQuestions.answeredBy))
      .where(and(eq(teamQuestions.tenantId, param(req, "tenantId")), eq(teamQuestions.status, status)))
      .orderBy(status === "open" ? teamQuestions.createdAt : desc(teamQuestions.answeredAt))
      .limit(100);
    res.json({
      questions: rows.map(({ q, customer, answeredBy }) => ({
        id: q.id,
        conversationId: q.conversationId,
        customer: { name: customer.name?.trim() || formatPhone(customer.waId), phone: formatPhone(customer.waId) },
        question: q.question,
        context: q.context,
        customerMessage: q.customerMessage,
        status: q.status,
        answer: q.answer,
        answeredBy: answeredBy ? { name: answeredBy } : null,
        answeredAt: q.answeredAt,
        createdAt: q.createdAt,
      })),
    });
  });

  api.post("/tenants/:tenantId/team-questions/:questionId/answer", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const questionId = param(req, "questionId");
    const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
    if (!isUuid(questionId)) return res.status(404).json({ error: "Soru bulunamadı" });
    if (!answer || answer.length > 2000) return res.status(400).json({ error: "Cevap boş olamaz ve en fazla 2000 karakter olabilir." });
    const locals = res.locals as Locals;
    // Ders bütün konuşmaları etkiler: yalnızca mağaza sahibi öğretebilir.
    const teach = req.body?.teach === true && (locals.role === "owner" || locals.user!.isSuperAdmin);
    const result = await answerTeamQuestion(db, { tenantId, questionId, answer, userId: locals.user!.id, teach });
    if (!result) return res.status(409).json({ error: "Bu soru zaten cevaplanmış." });
    deps.triggerReply?.(result.conversationId);
    deps.events?.publish(tenantId, { type: "team_question", conversationId: result.conversationId });
    // Lina cevabı müşteriye iletebilir mi? Konuşma ekipteyse ya da Lina kapalıysa iletmez; ekran gerçeği söylesin.
    const [row] = await db
      .select({ status: conversations.status, settings: tenants.settings })
      .from(conversations)
      .innerJoin(tenants, eq(tenants.id, conversations.tenantId))
      .where(eq(conversations.id, result.conversationId));
    const relay = !row ? "lina" : !resolveSettings(row.settings).botEnabled ? "bot_off" : row.status === "human" ? "in_team" : "lina";
    res.json({ ok: true, taught: teach, windowClosed: result.windowClosed, relay });
  });
}
