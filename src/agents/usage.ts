import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "../db/client.js";
import { agentRuns } from "../db/schema.js";

/**
 * Ajan döngüsü dışındaki tek çağrıların (kart yazarı, eğitmen) kullanımını agent_runs'a yazar;
 * maliyet tablosunda (panel İstatistik) bütün harcama görünsün.
 */
export async function recordUsage(
  db: DB,
  run: {
    tenantId: string;
    conversationId: string | null;
    agent: string;
    model: string;
    response: Anthropic.Message;
    startedAt: number;
    input?: string | null;
    output?: string | null;
    source?: "live" | "test";
  },
) {
  const u = run.response.usage;
  await db.insert(agentRuns).values({
    tenantId: run.tenantId,
    conversationId: run.conversationId,
    agent: run.agent,
    model: run.model,
    input: run.input ?? null,
    output: run.output ?? null,
    stopReason: run.response.stop_reason,
    apiCalls: 1,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    durationMs: Date.now() - run.startedAt,
    source: run.source ?? "live",
  });
}
