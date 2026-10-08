import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETURN_STATUS_UNAVAILABLE, runLina } from "../src/agents/lina.js";
import type { Llm } from "../src/agents/runner.js";
import { businessStatus } from "../src/core/business-hours.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { tenants, type Tenant } from "../src/db/schema.js";
import { demoOrderSource, demoReturnsProvider } from "../src/orders/demo.js";

const PHONE = "905321234567";
const base = { id: "m", type: "message", role: "assistant", model: "x", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const toolUse = (name: string, input: unknown) => ({ ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: `t-${name}`, name, input }] }) as unknown as Anthropic.Message;
const text = (t: string) => ({ ...base, stop_reason: "end_turn", content: [{ type: "text", text: t, citations: null }] }) as unknown as Anthropic.Message;
const turn = { firstContact: false, business: businessStatus({ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }, "Europe/Istanbul"), openHandoff: null, memory: null, askedTeam: [], teamAnswers: { fresh: [], earlier: [] } };
const history: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: "MO-9012 iadem ne durumda?" }] }];

describe("iadem ne durumda? (iade sistemi bağlı değilse durum uydurulmaz)", () => {
  let database: Database;
  let tenant: Tenant;
  beforeAll(async () => {
    database = await openDatabase({});
    [tenant] = (await database.db.insert(tenants).values({ slug: "betulsaday", name: "Betül Saday" }).returning()) as [Tenant];
  });
  afterAll(() => database.close());

  function scripted() {
    const seen = { returnsAgent: 0, linaToolResult: "" };
    const llm: Llm = {
      async create(params) {
        const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
        if (system.includes("iade ve değişim uzmanısın")) {
          seen.returnsAgent++;
          return text("İADE UZMANI: talep inceleniyor");
        }
        const last = (params.messages.at(-1)!.content as Anthropic.ContentBlockParam[])[0]!;
        if (last.type === "tool_result") {
          seen.linaToolResult = String((last as Anthropic.ToolResultBlockParam).content);
          return text("Lina cevabı");
        }
        return toolUse("ask_returns_agent", { topic: "return_status", question: "İadem ne durumda?", order_number: "MO-9012", customer_name: "", order_phone: "" });
      },
    };
    return { llm, seen };
  }
  const orders = (returns: ReturnType<typeof demoReturnsProvider> | null) => ({ source: demoOrderSource(() => PHONE), waId: PHONE, timeZone: "Europe/Istanbul", now: new Date(), returns, identityLocked: false });

  it("iade sistemi yoksa uzmana sorulmaz; Lina'ya durum uydurmaması ve ekibe sorması söylenir", async () => {
    const { llm, seen } = scripted();
    const ctx = { db: database.db, llm, model: "m", tenantId: tenant.id, conversationId: null };
    await runLina(ctx, tenant, history, turn, null, orders(null) as never, []);
    expect(seen.returnsAgent).toBe(0);
    expect(seen.linaToolResult).toBe(RETURN_STATUS_UNAVAILABLE);
    expect(seen.linaToolResult).toContain("ask_team");
  });

  it("iade sistemi bağlıysa iade uzmanı normal çalışır", async () => {
    const { llm, seen } = scripted();
    const ctx = { db: database.db, llm, model: "m", tenantId: tenant.id, conversationId: null };
    await runLina(ctx, tenant, history, turn, null, orders(demoReturnsProvider()) as never, []);
    expect(seen.returnsAgent).toBe(1);
    expect(seen.linaToolResult).toContain("İADE UZMANI");
  });
});
