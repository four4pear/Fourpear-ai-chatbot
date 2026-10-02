import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { lessons, messages, teamQuestions } from "../db/schema.js";

/**
 * Lina soruyor (docs/lina-davranis.md "Lina soruyor"): Lina bilmediği konuyu arka planda ekibe sorar,
 * ekip panelden cevaplar, cevap konuşmaya iç bilgi olarak eklenir ve Lina müşteriye kendisi iletir.
 */
export const TEAM_ANSWER_TYPE = "team_answer";

export type AskedQuestion = { question: string; context: string };

export async function recordTeamQuestions(
  db: DB,
  input: { tenantId: string; conversationId: string; customerMessage: string; items: AskedQuestion[] },
) {
  if (!input.items.length) return [];
  return db
    .insert(teamQuestions)
    .values(
      input.items.map((q) => ({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        question: q.question.slice(0, 2000),
        context: q.context.slice(0, 4000),
        customerMessage: input.customerMessage.slice(0, 2000),
      })),
    )
    .returning({ id: teamQuestions.id });
}

/** Bu konuşmada ekibe sorulmuş ve henüz cevaplanmamış sorular (Lina aynı şeyi yeniden sormasın). */
export async function openTeamQuestions(db: DB, conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ question: teamQuestions.question })
    .from(teamQuestions)
    .where(and(eq(teamQuestions.conversationId, conversationId), eq(teamQuestions.status, "open")))
    .orderBy(asc(teamQuestions.createdAt));
  return rows.map((r) => r.question);
}

/** Konuşmaya eklenen iç bilginin metni (Lina görür, müşteri görmez). */
export const teamAnswerText = (question: string, answer: string) => `Soru: ${question}\nEkibin cevabı: ${answer}`;

/**
 * Ekibin cevabı: soru kapanır, cevap konuşmaya iç bilgi olarak eklenir; `teach` ile Lina'ya ders
 * olarak da öğretilir (bir daha sormaz). Soru zaten cevaplandıysa null döner.
 */
export async function answerTeamQuestion(
  db: DB,
  input: { tenantId: string; questionId: string; answer: string; userId: string | null; teach: boolean },
) {
  return db.transaction(async (tx) => {
    const [question] = await tx
      .update(teamQuestions)
      .set({ status: "answered", answer: input.answer, answeredBy: input.userId, answeredAt: sql`now()` })
      .where(and(eq(teamQuestions.id, input.questionId), eq(teamQuestions.tenantId, input.tenantId), eq(teamQuestions.status, "open")))
      .returning();
    if (!question) return null;
    await tx.insert(messages).values({
      tenantId: input.tenantId,
      conversationId: question.conversationId,
      sender: "system",
      type: TEAM_ANSWER_TYPE,
      text: teamAnswerText(question.question, input.answer),
    });
    if (input.teach) {
      await tx.insert(lessons).values({
        tenantId: input.tenantId,
        text: `${question.question} → ${input.answer}`,
        source: "team",
        createdBy: input.userId,
      });
    }
    // Müşterinin son mesajı 24 saatten eskiyse WhatsApp serbest mesaja izin vermez.
    const [last] = await tx
      .select({ at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, question.conversationId), eq(messages.sender, "customer")))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(1);
    const windowClosed = !last || Date.now() - last.at.getTime() > 24 * 60 * 60 * 1000;
    return { conversationId: question.conversationId, windowClosed };
  });
}
