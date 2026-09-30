import { z } from "zod";
import type { Tenant } from "../db/schema.js";
import { addIssue, orderLookup, type CustomerIdentity, type OrderAgentDeps, type OrderFindings, type OrderTopic } from "./order-lookup.js";
import { orderAgentSystemPrompt } from "./prompts.js";
import { runAgent, type AgentContext, type AgentTool } from "./runner.js";

export { newFindings, ORDER_TOPICS, type OrderAgentDeps, type OrderFindings, type OrderTopic } from "./order-lookup.js";

export type OrderRequest = { topic: OrderTopic; question: string; orderNumber: string | null; identity?: CustomerIdentity };

const TOPIC_LABELS: Record<OrderTopic, string> = {
  status: "sipariş durumu, kargo, ön sipariş",
  cancel: "iptal isteği",
  change: "kargodan önce değişiklik isteği (beden, renk, adres)",
  return: "iade / değişim isteği",
  complaint: "şikayet (hasarlı, hatalı, yanlış ürün ya da gelmeyen teslimat)",
  return_status: "iade talebinin durumu",
  other: "diğer",
};

const delayInput = z.object({ order_number: z.string().min(1), product: z.string().min(1), planned_date: z.string().min(1) });

/**
 * Sipariş uzmanı: siparişi doğrular, bilgi kartını okur ve müşterinin sorusuna Lina için cevap yazar.
 * Doğrulama ve gecikme/takip tespiti kodda yapılır; model yalnızca yorumlar.
 */
export async function askOrderAgent(
  ctx: AgentContext,
  tenant: Tenant,
  deps: OrderAgentDeps,
  request: OrderRequest,
  findings: OrderFindings,
): Promise<string> {
  const withReturns = ["return", "return_status", "complaint"].includes(request.topic);
  const lookup = orderLookup(ctx, tenant, deps, findings, { withReturns, identity: request.identity });

  const tools: AgentTool[] = [
    ...lookup.tools,
    {
      definition: {
        name: "report_delay",
        description:
          "Bilgi kartının GECİKME olarak işaretlemediği ama tarihi geçmiş ve henüz kargoya verilmemiş bir ön siparişi ekibe bildirir.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            order_number: { type: "string" },
            product: { type: "string", description: "Ürün ve varyant, ör. Lavin Etek (Siyah)" },
            planned_date: { type: "string", description: "Açıklamadaki planlanan kargo tarihi, ör. 25 Eylül 2026" },
          },
          required: ["order_number", "product", "planned_date"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        const { order_number, product, planned_date } = delayInput.parse(input);
        const name = lookup.verifiedName(order_number);
        if (!name) throw new Error("Bu sipariş doğrulanmadı; önce get_order ile bakılmalı.");
        addIssue(findings, { kind: "delay", orderName: name, text: `Gecikme: ${product}, planlanan kargo ${planned_date}` });
        return "Gecikme ekibe bildirilecek.";
      },
    },
  ];

  const prefetched = await lookup.prefetch(request.orderNumber);

  const result = await runAgent(ctx, {
    agent: "order",
    system: orderAgentSystemPrompt(tenant, { returns: Boolean(deps.returns) }),
    messages: [{ role: "user", content: `Konu: ${TOPIC_LABELS[request.topic]}\nSoru: ${request.question}\n\n${prefetched}` }],
    tools,
    effort: "low",
    inputLabel: `[${TOPIC_LABELS[request.topic]}] ${request.question}${request.orderNumber ? ` (${request.orderNumber})` : ""}`,
  });
  if (result.stopReason === "refusal" || !result.text) return "Sipariş uzmanı bu soruya cevap veremedi.";
  return result.text;
}
