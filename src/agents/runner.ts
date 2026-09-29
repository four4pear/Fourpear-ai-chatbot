import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "../db/client.js";
import { agentRuns } from "../db/schema.js";

/** Claude'a istek atan asgari arayüz; testlerde sahte model kullanılır. */
export interface Llm {
  /** signal iptal edilince istek yarıda kesilir (müşteri yeni mesaj yazdı). */
  create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

export function llmFromClient(client: Anthropic): Llm {
  return { create: (params, opts) => client.messages.create(params, { signal: opts?.signal }) };
}

/**
 * Cevap hazırlanırken müşteri yeni mesaj yazdı: hazırlanan cevap iptal edildi.
 * Bu bir hata değildir: özür mesajı gönderilmez, konuşma devredilmez.
 */
export class CancelledError extends Error {
  constructor() {
    super("İptal edildi: müşteri yeni mesaj yazdı");
  }
}

export type AgentContext = {
  db: DB;
  llm: Llm;
  model: string;
  tenantId: string;
  conversationId: string | null;
  /** İptal sinyali; Lina ve çağırdığı uzmanlar aynı sinyali paylaşır. */
  signal?: AbortSignal;
  /** Araç hataları (ör. Shopify erişimi) sessiz kalmasın diye. */
  log?: Pick<Console, "warn">;
};

/** Claude isteği hatasının ekip ve kayıtlar için kısa Türkçe açıklaması. */
export function describeLlmError(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (/credit balance is too low/i.test(message)) return "yapay zekâ hesabının kredisi bitti (console.anthropic.com → Plans & Billing)";
  if (status === 401 || /invalid x-api-key|authentication/i.test(message)) return "yapay zekâ anahtarı geçersiz";
  if (status === 429) return "yapay zekâ kullanım sınırına takıldı";
  if (status === 529 || (status !== undefined && status >= 500) || /overloaded/i.test(message)) {
    return "yapay zekâ servisi geçici olarak yanıt vermiyor";
  }
  return "teknik hata";
}

export type AgentTool = {
  definition: Anthropic.Tool;
  /** Aracın sonucu (Claude'a metin olarak döner). Hata fırlatırsa is_error olarak iletilir. */
  run: (input: unknown) => Promise<string>;
};

export type AgentResult = {
  text: string;
  stopReason: Anthropic.StopReason | null;
};

type RunOptions = {
  agent: string;
  system: string;
  /** Mesaja özel sistem bilgisi; önbelleğe alınan sabit istemden sonra ayrı blok olarak gider. */
  systemContext?: string;
  messages: Anthropic.MessageParam[];
  tools?: AgentTool[];
  effort: "low" | "medium" | "high";
  /** Loglarda görünecek girdi (ör. uzmana sorulan soru). */
  inputLabel?: string;
  maxIterations?: number;
};

/**
 * Tek bir ajan çalıştırması: Claude'u çağırır, araç çağrılarını yürütür,
 * cevap bitene kadar döner ve toplam kullanımı agent_runs tablosuna yazar.
 */
export async function runAgent(ctx: AgentContext, opts: RunOptions): Promise<AgentResult> {
  const started = Date.now();
  const tools = opts.tools ?? [];
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const messages = [...opts.messages];
  const usage = { apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let result: AgentResult = { text: "", stopReason: null };
  let error: string | null = null;

  try {
    for (let i = 0; i < (opts.maxIterations ?? 8); i++) {
      if (ctx.signal?.aborted) throw new CancelledError();
      const response = await ctx.llm.create(
        {
          model: ctx.model,
          max_tokens: 16000,
          // Sistem istemi mağaza başına sabit; önbelleğe alınır.
          system: [
            { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
            ...(opts.systemContext ? [{ type: "text" as const, text: opts.systemContext }] : []),
          ],
          ...(tools.length ? { tools: tools.map((t) => t.definition) } : {}),
          thinking: { type: "adaptive" },
          output_config: { effort: opts.effort },
          messages,
        },
        { signal: ctx.signal },
      );

      usage.apiCalls++;
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

      result = { text: textOf(response), stopReason: response.stop_reason };

      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (response.stop_reason !== "tool_use") return result;

      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      // Tüm araç sonuçları tek bir kullanıcı mesajında döner (paralel araç kullanımı).
      const toolResults = await Promise.all(
        calls.map((call) =>
          executeTool(byName.get(call.name), call, (message) => ctx.log?.warn(`[${opts.agent}] ${call.name} aracı hata verdi: ${message}`)),
        ),
      );
      messages.push({ role: "user", content: toolResults });
    }
    throw new Error(`${opts.agent} ajanı ${opts.maxIterations ?? 8} turda cevabı tamamlayamadı`);
  } catch (err) {
    if (ctx.signal?.aborted || err instanceof CancelledError) {
      error = "cancelled";
      throw err instanceof CancelledError ? err : new CancelledError();
    }
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await ctx.db.insert(agentRuns).values({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      agent: opts.agent,
      model: ctx.model,
      input: opts.inputLabel ?? null,
      output: result.text || null,
      stopReason: result.stopReason,
      ...usage,
      durationMs: Date.now() - started,
      error,
    });
  }
}

async function executeTool(
  tool: AgentTool | undefined,
  call: Anthropic.ToolUseBlock,
  onError: (message: string) => void,
): Promise<Anthropic.ToolResultBlockParam> {
  if (!tool) {
    return { type: "tool_result", tool_use_id: call.id, content: `Bilinmeyen araç: ${call.name}`, is_error: true };
  }
  try {
    return { type: "tool_result", tool_use_id: call.id, content: await tool.run(call.input) };
  } catch (err) {
    // İptal bir araç hatası değildir: Lina'ya "araç hatası" diye dönmez, en üste iletilir.
    if (err instanceof CancelledError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    onError(message);
    return { type: "tool_result", tool_use_id: call.id, content: `Araç hatası: ${message}`, is_error: true };
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
