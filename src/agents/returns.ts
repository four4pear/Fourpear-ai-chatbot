import { z } from "zod";
import type { Tenant } from "../db/schema.js";
import type { KnowledgeBase } from "../knowledge/base.js";
import { legalDocumentTool, reportConflictTool } from "./knowledge.js";
import { addIssue, orderLookup, type CustomerIdentity, type OrderAgentDeps, type OrderFindings } from "./order-lookup.js";
import { returnsAgentSystemPrompt } from "./prompts.js";
import { runAgent, type AgentContext, type AgentTool } from "./runner.js";

/** Lina'nın iade uzmanına sorarken seçtiği konu. */
export const RETURN_TOPICS = ["return", "return_status", "damaged"] as const;
export type ReturnTopic = (typeof RETURN_TOPICS)[number];

export type ReturnRequest = { topic: ReturnTopic; question: string; orderNumber: string | null; identity?: CustomerIdentity };

const TOPIC_LABELS: Record<ReturnTopic, string> = {
  return: "iade ya da değişim isteği, iade koşulları",
  return_status: "açılmış iade talebinin durumu",
  damaged: "hasarlı, hatalı ya da yanlış ürün",
};

const NO_ORDERS =
  "Sipariş sistemi bağlı değil: siparişe özel bilgi (ürünün sipariş tarihindeki koşulu, iade talebinin durumu) görülemez.";

const forwardInput = z.object({ order_number: z.string(), reason: z.string().min(1) });

/**
 * İade ve değişim uzmanı (docs/lina-davranis.md "İade uzmanı"). Sipariş sistemi bağlıysa siparişi
 * doğrular, ürünün sipariş tarihindeki koşulunu ve iade talebinin durumunu okur; ekip kararı
 * gereken talebi forward_to_team ile önemli bildirim olarak iletir. Bağlı değilse politikalar ve
 * el kitabıyla cevaplar; iletilmesi gerekeni Lina devreder.
 */
export async function askReturnsAgent(
  ctx: AgentContext,
  tenant: Tenant,
  deps: { knowledge: KnowledgeBase | null; orders: OrderAgentDeps | null },
  request: ReturnRequest,
  findings: OrderFindings,
): Promise<string> {
  const tools: AgentTool[] = [reportConflictTool(ctx, tenant)];
  let context = NO_ORDERS;

  if (deps.orders) {
    const lookup = orderLookup(ctx, tenant, deps.orders, findings, { withReturns: true, identity: request.identity });
    tools.push(...lookup.tools, {
      definition: {
        name: "forward_to_team",
        description: "Ekip kararı gereken iade talebini mağazanın iade sorumlusuna iletir (panelde önemli bildirim).",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            order_number: { type: "string", description: "Doğrulanmış sipariş numarası; sipariş belli değilse boş metin." },
            reason: {
              type: "string",
              description:
                "Ekip için kısa sebep ve talep, ör. 'Kampanyalı Riva Takım'ı beden olmadı diye iade etmek istiyor; kampanya yalnızca hasarlı üründe iade diyor.'",
            },
          },
          required: ["order_number", "reason"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        const { order_number, reason } = forwardInput.parse(input);
        const orderName = order_number.trim() ? (lookup.verifiedName(order_number) ?? "") : "";
        addIssue(findings, { kind: "return_review", orderName, text: `İade: ${reason}` });
        return "Ekibe iletilecek.";
      },
    });
    context = await lookup.prefetch(request.orderNumber);
  }

  if (deps.knowledge) {
    const legal = legalDocumentTool(ctx, tenant, deps.knowledge);
    if (legal) tools.push(legal);
  }

  const result = await runAgent(ctx, {
    agent: "returns",
    system: returnsAgentSystemPrompt(tenant, deps.knowledge, { orders: Boolean(deps.orders), returns: Boolean(deps.orders?.returns) }),
    messages: [{ role: "user", content: `Konu: ${TOPIC_LABELS[request.topic]}\nMüşterinin mesajı: ${request.question}\n\n${context}` }],
    tools,
    // Kural önceliği (el kitabı, kampanya, politika) ve ekibe iletme kararı biraz düşünmeyi gerektirir.
    effort: "medium",
    inputLabel: `[${TOPIC_LABELS[request.topic]}] ${request.question}${request.orderNumber ? ` (${request.orderNumber})` : ""}`,
  });
  if (result.stopReason === "refusal" || !result.text) return "İade uzmanı bu soruya cevap veremedi.";
  return result.text;
}
