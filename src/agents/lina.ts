import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Tenant } from "../db/schema.js";
import type { KnowledgeBase } from "../knowledge/base.js";
import { askKnowledgeAgent } from "./knowledge.js";
import { askOrderAgent, newFindings, type OrderAgentDeps, type OrderFindings } from "./orders.js";
import { linaSystemPrompt, turnContext, type TurnInfo } from "./prompts.js";
import { askReturnsAgent, RETURN_TOPICS } from "./returns.js";
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
/** İade, değişim ve hasarlı ürün iade uzmanına gider; sipariş uzmanı geri kalan sipariş konularına bakar. */
const ORDER_AGENT_TOPICS = ["status", "cancel", "change", "complaint", "other"] as const;
const orderInput = z.object({ topic: z.enum(ORDER_AGENT_TOPICS), question: z.string().min(1), order_number: z.string() });
const returnsInput = z.object({ topic: z.enum(RETURN_TOPICS), question: z.string().min(1), order_number: z.string() });

const orderNumberProperty = {
  type: "string",
  description: "Müşterinin verdiği sipariş numarası (ör. #1271); vermediyse boş metin.",
} as const;

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
      "ask_store_info_agent (mağaza bilgi uzmanı): kargo süresi ve ücreti, ödeme, beden tablosu, üretim, iletişim, kampanyalar, sözleşme/KVKK gibi mağaza bilgileri. İade ve değişim için iade uzmanına sor.",
    );
    tools.push(
      specialistTool(
        "ask_store_info_agent",
        "Mağaza bilgi uzmanına soru sorar (kargo, ödeme, beden, üretim, iletişim, kampanyalar, sözleşme/KVKK). İade ve değişim için değil.",
        (q) => askKnowledgeAgent(ctx, tenant, knowledge, q),
      ),
    );
  }

  const findings = newFindings();
  specialists.push(
    `ask_returns_agent (iade ve değişim uzmanı): iade ve değişim istekleri ve koşulları, hasarlı, hatalı ya da yanlış ürün, açılmış iade talebinin durumu. Mağazanın iade el kitabını${orders ? ", siparişteki ürünün iade koşulunu ve iade talebinin durumunu" : " ve politikalarını"} bilir; sana müşteriye ne söyleyeceğini ve konunun ekibe iletilip iletilmediğini yazar.`,
  );
  tools.push({
    definition: {
      name: "ask_returns_agent",
      description: "İade ve değişim uzmanına sorar: iade/değişim isteği ve koşulları, hasarlı/hatalı/yanlış ürün, iade talebinin durumu.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: [...RETURN_TOPICS],
            description: "return: iade ya da değişim isteği, iade koşulları · return_status: açılmış iade talebinin durumu · damaged: hasarlı, hatalı ya da yanlış ürün",
          },
          question: {
            type: "string",
            description:
              "Uzmana tek başına anlaşılır soru: müşterinin ne istediği ve söylediği ayrıntılar (ürün, beden, renk, sebep, para iadesi mi değişim mi, fotoğraf gönderdi mi). Müşteriye kuralı daha önce söylediysen ve yine de istiyorsa bunu da yaz.",
          },
          order_number: orderNumberProperty,
        },
        required: ["topic", "question", "order_number"],
        additionalProperties: false,
      },
    },
    run: async (input) => {
      const { topic, question, order_number } = returnsInput.parse(input);
      // Bildirim yalnızca sipariş sistemi bağlıyken; bağlı değilse iletilecek konu devredilir.
      if (orders) findings.topics.push(topic === "damaged" ? "complaint" : topic);
      try {
        return await askReturnsAgent(ctx, tenant, { knowledge, orders }, { topic, question, orderNumber: order_number.trim() || null }, findings);
      } catch (err) {
        if (orders && !(err instanceof CancelledError)) findings.lookupFailed = true;
        throw err;
      }
    },
  });

  if (orders) {
    specialists.push(
      "ask_order_agent (sipariş uzmanı): sipariş durumu, kargo ve takip, ön sipariş tarihi, gecikme, iptal ve kargodan önce değişiklik istekleri, teslim edildi görünüp eline ulaşmayan sipariş. Yalnızca müşterinin WhatsApp numarasına ait siparişlere bakar.",
    );
    tools.push({
      definition: {
        name: "ask_order_agent",
        description:
          "Sipariş uzmanına sorar: durum, kargo/takip, ön sipariş, gecikme, iptal ve değişiklik isteği, eline ulaşmayan teslimat. İade, değişim ve hasarlı ürün için değil.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              enum: [...ORDER_AGENT_TOPICS],
              description:
                "status: durum/kargo/ön sipariş · cancel: iptal isteği · change: kargodan önce beden/renk/adres değişikliği · complaint: teslim edildi görünüp eline ulaşmayan ya da kargoda sorun yaşanan sipariş · other",
            },
            question: {
              type: "string",
              description: "Uzmana tek başına anlaşılır soru; müşterinin istediği değişiklik varsa ayrıntısı (yeni beden, renk, adres).",
            },
            order_number: orderNumberProperty,
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
        ? "Konuşmayı mağaza ekibine devreder: cevabı bilinmeyen sorular, mağaza bilgilerinde çelişki ve ısrarla temsilci isteyen ya da öfkesi süren müşteriler için. Sipariş, iade, iptal, değişiklik ve şikayet konularında kullanma; bunlar için ask_order_agent ve ask_returns_agent var."
        : "Konuşmayı mağaza ekibine devreder: iade uzmanının ekibe iletilmeli dediği talepler, iptal/değişiklik/adres talepleri ve şikayetler (bilgiler toplandıktan sonra), cevabı bilinmeyen sorular ve ısrarla temsilci isteyen müşteriler için.",
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
      return "Devir kaydedildi. Müşteriye talebini ilgili sorumlu arkadaşa ilettiğini ve ekibin ne zaman döneceğini (mesai bilgisine göre) söyle.";
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
