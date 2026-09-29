import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Tenant } from "../db/schema.js";
import type { KnowledgeBase } from "../knowledge/base.js";
import { askKnowledgeAgent } from "./knowledge.js";
import { askOrderAgent, newFindings, ORDER_TOPICS, type OrderAgentDeps, type OrderFindings } from "./orders.js";
import { linaSystemPrompt, turnContext, type TurnInfo } from "./prompts.js";
import { CancelledError, runAgent, type AgentContext, type AgentTool } from "./runner.js";

export const HANDOFF_REASONS = ["return_or_cancel", "complaint", "customer_request", "unknown_answer", "other"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export type HandoffRequest = { reason: HandoffReason; summary: string };

export type LinaResult =
  /** orders: bu cevapta sipariş uzmanına soruldu; cevap gidince ekibe bildirim kurulur. */
  | { kind: "reply"; text: string; handoff: HandoffRequest | null; orders: OrderFindings | null }
  /** Model cevap üretemedi (reddetti ya da boş döndü); çağıran taraf devreder. */
  | { kind: "failed"; stopReason: string | null };

const questionInput = z.object({ question: z.string().min(1) });
const handoffInput = z.object({ reason: z.enum(HANDOFF_REASONS), summary: z.string().min(1) });
const orderInput = z.object({ topic: z.enum(ORDER_TOPICS), question: z.string().min(1), order_number: z.string() });

function specialistTool(name: string, description: string, run: (question: string) => Promise<string>): AgentTool {
  return {
    definition: {
      name,
      description,
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Uzmana sorulacak, tek başına anlaşılır soru (müşterinin söylediği ilgili ayrıntılarla).",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    run: async (input) => run(questionInput.parse(input).question),
  };
}

/**
 * Müşteriyle konuşan yönlendirici ajan. Mağazanın bağlı entegrasyonlarına göre
 * uzman araçlarını açar; devir isteğini kaydetmek yerine çağırana döndürür.
 */
export async function runLina(
  ctx: AgentContext,
  tenant: Tenant,
  history: Anthropic.MessageParam[],
  turn: TurnInfo,
  knowledge: KnowledgeBase | null,
  orders: OrderAgentDeps | null = null,
): Promise<LinaResult> {
  const tools: AgentTool[] = [];
  const specialists: string[] = [];

  if (knowledge) {
    specialists.push(
      "ask_store_info_agent (mağaza bilgi uzmanı): kargo, iade/değişim koşulları, ödeme, beden tablosu, üretim, iletişim, kampanyalar, sözleşme/KVKK gibi mağaza bilgileri.",
    );
    tools.push(
      specialistTool(
        "ask_store_info_agent",
        "Mağaza bilgi uzmanına soru sorar (kargo, iade, ödeme, beden, üretim, iletişim, kampanyalar, sözleşme/KVKK).",
        (q) => askKnowledgeAgent(ctx, tenant, knowledge, q),
      ),
    );
  }

  const findings = newFindings();
  if (orders) {
    specialists.push(
      "ask_order_agent (sipariş uzmanı): sipariş durumu, kargo ve takip, ön sipariş tarihi, ürünün kampanya/iade koşulu, iptal, değişiklik ve iade istekleri, şikayetler, iade talebinin durumu. Yalnızca müşterinin WhatsApp numarasına ait siparişlere bakar.",
    );
    tools.push({
      definition: {
        name: "ask_order_agent",
        description:
          "Sipariş uzmanına sorar: durum, kargo/takip, ön sipariş, kampanya ve iade koşulu, iptal/değişiklik/iade isteği, şikayet, iade talebinin durumu.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              enum: [...ORDER_TOPICS],
              description:
                "status: durum/kargo/ön sipariş · cancel: iptal isteği · change: kargodan önce beden/renk/adres değişikliği · return: iade/değişim isteği · complaint: hasarlı, hatalı, yanlış ürün ya da eline ulaşmayan teslimat · return_status: iade talebinin durumu · other",
            },
            question: {
              type: "string",
              description: "Uzmana tek başına anlaşılır soru; müşterinin istediği değişiklik varsa ayrıntısı (yeni beden, renk, adres).",
            },
            order_number: {
              type: "string",
              description: "Müşterinin verdiği sipariş numarası (ör. #1271); vermediyse boş metin.",
            },
          },
          required: ["topic", "question", "order_number"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        const { topic, question, order_number } = orderInput.parse(input);
        findings.topics.push(topic);
        try {
          return await askOrderAgent(ctx, tenant, orders, { topic, question, orderNumber: order_number.trim() || null }, findings);
        } catch (err) {
          // Sipariş sistemine ulaşılamadı: müşterinin isteği sessiz kayda düşmesin (ekibe önemli bildirim).
          if (!(err instanceof CancelledError)) findings.lookupFailed = true;
          throw err;
        }
      },
    });
  }

  let handoff: HandoffRequest | null = null;
  tools.push({
    definition: {
      name: "handoff_to_human",
      description: orders
        ? "Konuşmayı mağaza ekibine devreder: cevabı bilinmeyen sorular, mağaza bilgilerinde çelişki ve ısrarla temsilci isteyen ya da öfkesi süren müşteriler için. Sipariş, iade, iptal, değişiklik ve şikayet konularında kullanma; bunlar için ask_order_agent var."
        : "Konuşmayı mağaza ekibine devreder. İade/iptal/değişim/adres talepleri (bilgiler toplandıktan sonra), şikayetler, cevabı bilinmeyen sorular ve ısrarla temsilci isteyen müşteriler için kullan.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: [...HANDOFF_REASONS],
            description:
              "return_or_cancel: iade/iptal/değişim/adres · complaint: şikayet, hasarlı/yanlış ürün · customer_request: müşteri ısrarla temsilci istedi · unknown_answer: bilgi yok · other",
          },
          summary: {
            type: "string",
            description:
              "Ekip için Türkçe özet: müşteri ne istiyor ve toplanan bilgiler (sipariş no, ürün/beden/renk, sebep, talep, fotoğraf gönderildi mi).",
          },
        },
        required: ["reason", "summary"],
        additionalProperties: false,
      },
    },
    run: async (input) => {
      handoff = handoffInput.parse(input);
      return "Devir kaydedildi. Müşteriye talebini ekibe ilettiğini ve ne zaman dönüleceğini (mesai bilgisine göre) söyle.";
    },
  });

  const result = await runAgent(ctx, {
    agent: "lina",
    system: linaSystemPrompt(tenant, specialists, { orders: Boolean(orders) }),
    systemContext: turnContext(tenant, turn),
    messages: history,
    tools,
    effort: "medium",
    inputLabel: lastUserText(history),
  });

  if (result.stopReason === "refusal" || !result.text) return { kind: "failed", stopReason: result.stopReason };
  return { kind: "reply", text: result.text, handoff, orders: findings.topics.length ? findings : null };
}

function lastUserText(history: Anthropic.MessageParam[]): string | undefined {
  const last = history.at(-1);
  if (!last || last.role !== "user") return undefined;
  if (typeof last.content === "string") return last.content;
  return last.content
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join(" ");
}
