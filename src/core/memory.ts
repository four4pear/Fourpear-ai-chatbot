import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gt, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import { memoryWriterSystemPrompt } from "../agents/prompts.js";
import type { Llm } from "../agents/runner.js";
import type { DB } from "../db/client.js";
import { customerMemories, messages, type Tenant } from "../db/schema.js";

/**
 * Müşteri kartı (docs/lina-davranis.md "Müşteri kartı"): Lina'nın her müşteri hakkında hatırladıkları.
 * Her cevaptan sonra arka planda güncellenir; Lina bir sonraki konuşmada okur ve sessizce kullanır.
 */
export const MAX_MEMORY_LENGTH = 1500;
/** Müşteri son mesajından bu kadar gün sonra yazmazsa kartı silinir. */
export const MEMORY_RETENTION_DAYS = 183;
/** Bir güncellemede okunan en fazla mesaj (kartın son güncellemesinden sonrakiler). */
const MAX_NEW_MESSAGES = 30;

export type MemoryDeps = { db: DB; llm: Llm; model: string };

export async function loadMemory(db: DB, customerId: string): Promise<string | null> {
  const [row] = await db.select({ text: customerMemories.text }).from(customerMemories).where(eq(customerMemories.customerId, customerId));
  return row?.text || null;
}

const SAVE_TOOL: Anthropic.Tool = {
  name: "save_memory",
  description: "Müşteri kartının güncel halini kaydeder.",
  strict: true,
  input_schema: {
    type: "object",
    properties: { memory: { type: "string", description: "Kartın tamamı (güncellenmiş hali)." } },
    required: ["memory"],
    additionalProperties: false,
  },
};
const saveInput = z.object({ memory: z.string() });

const SENDER_LABELS: Record<string, string> = { customer: "Müşteri", bot: "Lina", agent: "Ekip", system: "Otomatik mesaj" };
/** Kartla ilgisiz olaylar: tepki, sticker, sistem bildirimleri ve paneldeki iç notlar. */
const SKIPPED_TYPES = ["reaction", "sticker", "system", "request_welcome", "note"];

const dayMonth = (d: Date, timeZone: string) => d.toLocaleDateString("tr-TR", { timeZone, day: "numeric", month: "long", year: "numeric" });

/**
 * Kartın son güncellemesinden sonraki mesajları okuyup kartı günceller. Konuşmada yeni bir şey
 * yoksa çağrı yapılmaz. Müşteri kartı yalnızca konuşmada geçenlerden yazılır (bkz. memoryWriterSystemPrompt).
 */
export async function updateMemory(
  deps: MemoryDeps,
  input: { tenant: Tenant; customerId: string; conversationId: string; now: Date; timeZone: string },
): Promise<string | null> {
  const { db } = deps;
  const [current] = await db.select().from(customerMemories).where(eq(customerMemories.customerId, input.customerId));
  const fresh = await db
    .select({ sender: messages.sender, type: messages.type, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        notInArray(messages.type, SKIPPED_TYPES),
        current ? gt(messages.createdAt, current.updatedAt) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(MAX_NEW_MESSAGES);
  if (!fresh.length) return current?.text ?? null;

  const lines = fresh
    .reverse()
    .map((m) => `[${dayMonth(m.createdAt, input.timeZone)}] ${SENDER_LABELS[m.sender] ?? m.sender}: ${m.text ?? `[${m.type}]`}`)
    .join("\n");
  const res = await deps.llm.create({
    model: deps.model,
    max_tokens: 1500,
    system: memoryWriterSystemPrompt(input.tenant),
    messages: [
      {
        role: "user",
        content: `Bugün: ${dayMonth(input.now, input.timeZone)}\n\n## Mevcut kart\n${current?.text || "(henüz kart yok)"}\n\n## Kartın son güncellemesinden sonraki mesajlar\n${lines}`,
      },
    ],
    tools: [SAVE_TOOL],
    tool_choice: { type: "tool", name: SAVE_TOOL.name },
  });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!call) throw new Error("Müşteri kartı yazılamadı");
  const text = saveInput.parse(call.input).memory.trim().slice(0, MAX_MEMORY_LENGTH);

  const lastCustomerMessage = fresh.filter((m) => m.sender === "customer").at(-1)?.createdAt;
  const values = {
    tenantId: input.tenant.id,
    customerId: input.customerId,
    text,
    // Okunan son mesajın anı: sonraki güncelleme bundan sonrasını okur.
    updatedAt: fresh.at(-1)!.createdAt,
    lastActivityAt: lastCustomerMessage ?? current?.lastActivityAt ?? input.now,
  };
  await db.insert(customerMemories).values(values).onConflictDoUpdate({ target: customerMemories.customerId, set: values });
  return text;
}

/** Saklama süresi dolan kartları siler (son mesajdan 6 ay); silinen sayısını döner. */
export async function purgeExpiredMemories(db: DB, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(customerMemories).where(lt(customerMemories.lastActivityAt, cutoff)).returning({ id: customerMemories.id });
  return deleted.length;
}

/** Testte ya da panelde gösterim için: müşterinin kartı ve güncellenme zamanı. */
export async function memoryRow(db: DB, customerId: string) {
  const [row] = await db
    .select({ text: customerMemories.text, updatedAt: customerMemories.updatedAt })
    .from(customerMemories)
    .where(eq(customerMemories.customerId, customerId));
  return row ?? null;
}
