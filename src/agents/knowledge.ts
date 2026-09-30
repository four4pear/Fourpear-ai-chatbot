import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { knowledgeAlerts, type Tenant } from "../db/schema.js";
import { readLegalDoc, type KnowledgeBase } from "../knowledge/base.js";
import { knowledgeAgentSystemPrompt } from "./prompts.js";
import { runAgent, type AgentContext, type AgentTool } from "./runner.js";

const legalInput = z.object({ doc_id: z.string() });
const conflictInput = z.object({ topic: z.string().min(1), description: z.string().min(1) });

/** Mağaza bilgi uzmanı: notlar, politikalar ve sayfalardan cevap verir; çelişkileri kaydeder. */
export async function askKnowledgeAgent(ctx: AgentContext, tenant: Tenant, kb: KnowledgeBase, question: string): Promise<string> {
  const tools: AgentTool[] = [reportConflictTool(ctx, tenant)];

  const legal = legalDocumentTool(ctx, tenant, kb);
  if (legal) tools.push(legal);

  const result = await runAgent(ctx, {
    agent: "knowledge",
    system: knowledgeAgentSystemPrompt(tenant, kb),
    messages: [{ role: "user", content: question }],
    tools,
    effort: "low",
    inputLabel: question,
  });
  if (result.stopReason === "refusal" || !result.text) return "Bilgi uzmanı bu soruya cevap veremedi.";
  return result.text;
}

/** Hukuki metinlerin (sözleşme, cayma hakkı, KVKK) tam metnini okuma aracı; metin yoksa araç da yok. */
export function legalDocumentTool(ctx: AgentContext, tenant: Tenant, kb: KnowledgeBase): AgentTool | null {
  if (!kb.legal.length) return null;
  return {
    definition: {
      name: "read_legal_document",
      description: "Listelenen hukuki metinlerden birinin tam metnini getirir.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { doc_id: { type: "string", enum: kb.legal.map((d) => d.id) } },
        required: ["doc_id"],
        additionalProperties: false,
      },
    },
    run: async (input) => {
      const doc = await readLegalDoc(ctx.db, tenant.id, legalInput.parse(input).doc_id);
      if (!doc) throw new Error("Belge bulunamadı");
      return `${doc.title}${doc.url ? ` (${doc.url})` : ""}\n\n${doc.content}`;
    },
  };
}

/** Mağaza kaynakları aynı konuda farklı şey söylüyorsa panele uyarı düşer (aynı konuda açık uyarı varsa tekrar açılmaz). */
export function reportConflictTool(ctx: AgentContext, tenant: Tenant): AgentTool {
  return {
    definition: {
      name: "report_conflict",
      description: "Mağaza kaynakları aynı konuda farklı rakam veya kural söylüyorsa mağazaya panel uyarısı olarak bildirir.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Kısa konu, ör. 'İade süresi'" },
          description: {
            type: "string",
            description: "Hangi kaynak ne diyor, ör. 'Para iade politikası 14 gün, SSS sayfası 30 gün diyor.'",
          },
        },
        required: ["topic", "description"],
        additionalProperties: false,
      },
    },
    run: async (input) => {
      const { topic, description } = conflictInput.parse(input);
      const [open] = await ctx.db
        .select()
        .from(knowledgeAlerts)
        .where(and(eq(knowledgeAlerts.tenantId, tenant.id), eq(knowledgeAlerts.topic, topic), eq(knowledgeAlerts.status, "open")));
      if (!open) {
        await ctx.db.insert(knowledgeAlerts).values({ tenantId: tenant.id, conversationId: ctx.conversationId, topic, description });
      }
      return "Çelişki mağazaya bildirildi.";
    },
  };
}
