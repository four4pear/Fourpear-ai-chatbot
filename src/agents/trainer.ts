import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Lesson, Tenant } from "../db/schema.js";
import { trainerSystemPrompt } from "./prompts.js";
import type { DB } from "../db/client.js";
import type { Llm } from "./runner.js";
import { recordUsage } from "./usage.js";

export type TestTurn = { role: "user" | "assistant"; text: string };
export type LessonProposal = { summary: string; lessons: string[]; replaces: { id: string; text: string }[] };

const proposalInput = z.object({
  summary: z.string(),
  lessons: z.array(z.string().min(1)).max(5),
  replaces: z.array(z.string()),
});

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_lessons",
  description: "Geri bildirimden çıkan kuralları mağaza sahibinin onayına sunar.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: 'Mağaza sahibine tek cümle: "Anladım: ..."' },
      lessons: { type: "array", items: { type: "string" }, description: "Kaydedilecek kurallar (en fazla 5; kural yoksa boş)." },
      replaces: { type: "array", items: { type: "string" }, description: "Yerine geçilen mevcut derslerin kimlikleri (yoksa boş)." },
    },
    required: ["summary", "lessons", "replaces"],
    additionalProperties: false,
  },
};

/** Son konuşmanın bu kadar mesajı eğitmene gider; geri bildirim genelde son cevapla ilgilidir. */
const CONTEXT_TURNS = 12;

/**
 * Geri bildirimi kurallara çevirir; hiçbir şey kaydetmez (mağaza sahibi onaylayınca kaydedilir).
 * `existing`: mağazanın mevcut dersleri; yenisi bunlardan birinin yerine geçebilir.
 */
export async function proposeLessons(
  llm: Llm,
  model: string,
  db: DB,
  tenant: Tenant,
  conversation: TestTurn[],
  feedback: string,
  existing: Pick<Lesson, "id" | "text">[],
): Promise<LessonProposal> {
  const lines = conversation
    .slice(-CONTEXT_TURNS)
    .map((t) => `${t.role === "user" ? "Müşteri" : tenant.botName}: ${t.text}`)
    .join("\n");
  const known = existing.length ? existing.map((l) => `- [${l.id}] ${l.text}`).join("\n") : "(yok)";
  const startedAt = Date.now();
  const res = await llm.create({
    model,
    max_tokens: 2000,
    system: trainerSystemPrompt(tenant),
    messages: [
      {
        role: "user",
        content: `## Test konuşması (son kısmı)\n${lines || "(konuşma yok)"}\n\n## Mağaza sahibinin geri bildirimi\n${feedback}\n\n## ${tenant.botName}'nın mevcut dersleri\n${known}`,
      },
    ],
    tools: [PROPOSE_TOOL],
    tool_choice: { type: "tool", name: PROPOSE_TOOL.name },
  });
  // Eğitmen yalnızca test ekranında çalışır: maliyeti test harcamasına sayılır.
  await recordUsage(db, { tenantId: tenant.id, conversationId: null, agent: "trainer", model, response: res, startedAt, input: feedback, source: "test" });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!call) throw new Error("Eğitmen öneri üretmedi");
  const proposal = proposalInput.parse(call.input);
  const byId = new Map(existing.map((l) => [l.id, l.text]));
  return {
    summary: proposal.summary,
    lessons: proposal.lessons.map((l) => l.trim()).filter(Boolean),
    // Yalnızca gerçekten var olan dersler değiştirilebilir.
    replaces: proposal.replaces.filter((id) => byId.has(id)).map((id) => ({ id, text: byId.get(id)! })),
  };
}
