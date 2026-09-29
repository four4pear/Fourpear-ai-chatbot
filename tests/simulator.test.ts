import type Anthropic from "@anthropic-ai/sdk";
import { expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { agentRuns, customers, messages, tenants } from "../src/db/schema.js";
import { simulate } from "../src/panel/simulator.js";
import type { Deps } from "../src/core/conversation.js";

it("uses the test transcript but never writes or sends through production dependencies", async () => {
  const source = await openDatabase({});
  try {
    const [tenant] = await source.db.insert(tenants).values({ slug: "test", name: "Test" }).returning();
    const create = vi.fn(async () => ({
      id: "test", type: "message", role: "assistant", content: [{ type: "text", text: "İki iş günü.", citations: null }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
    } as Anthropic.Message));
    const sendText = vi.fn();
    const deps = { db: source.db, llm: { create }, wa: { sendText }, model: "test", historyLimit: 20, timeZone: "Europe/Istanbul", log: console } as unknown as Deps;
    const result = await simulate(deps, tenant!.id, [
      { role: "user", text: "Merhaba" }, { role: "assistant", text: "Merhaba, hoş geldiniz." }, { role: "user", text: "Kargo kaç gün?" },
    ], false);
    expect(result.replies).toEqual(["İki iş günü."]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls)).toContain("Merhaba, hoş geldiniz.");
    expect(sendText).not.toHaveBeenCalled();
    expect(await source.db.select().from(messages)).toEqual([]);
    expect(await source.db.select().from(customers)).toEqual([]);
    expect(await source.db.select().from(agentRuns)).toEqual([]);
  } finally { await source.close(); }
}, 30000);
