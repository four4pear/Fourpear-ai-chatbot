import { z } from "zod";
import type { Tenant } from "../db/schema.js";
import { describeProducts, type ProductSource } from "../products/types.js";
import { productAgentSystemPrompt } from "./prompts.js";
import { runAgent, type AgentContext, type AgentTool } from "./runner.js";

export type ProductAgentDeps = { source: ProductSource };

const searchInput = z.object({ query: z.string().min(1) });

/**
 * Ürün uzmanı: ürün var mı, hangi beden/renk stokta, fiyat ve indirim, ürün yazısındaki özellikler.
 * Bilgi Shopify'dan anlık okunur; stok sayısı değil yalnızca durum söylenir. Karar ve tahmin içermez.
 */
export async function askProductAgent(ctx: AgentContext, tenant: Tenant, deps: ProductAgentDeps, question: string): Promise<string> {
  const tools: AgentTool[] = [
    {
      definition: {
        name: "search_products",
        description:
          "Mağazanın aktif ürünlerinde ada göre arar; fiyat, beden/renk seçenekleri ve stok durumunu döner. Yalnızca ürün adını yaz (beden, renk, 'var mı' gibi sözcükler olmadan).",
        strict: true,
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "Ürün adı ya da bir bölümü, ör. 'Zen Takım' ya da 'lavin etek'." } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      run: async (input) => describeProducts(await deps.source.search(searchInput.parse(input).query)),
    },
  ];

  const result = await runAgent(ctx, {
    agent: "product",
    system: productAgentSystemPrompt(tenant),
    messages: [{ role: "user", content: question }],
    tools,
    effort: "low",
    inputLabel: question,
  });
  if (result.stopReason === "refusal" || !result.text) return "Ürün uzmanı bu soruya cevap veremedi.";
  return result.text;
}
