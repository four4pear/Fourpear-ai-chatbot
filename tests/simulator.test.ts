import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { agentRuns, customers, messages, notifications, tenants, whatsappAccounts } from "../src/db/schema.js";
import { replySummary, simulate, type SimulationMode } from "../src/panel/simulator.js";
import type { Deps } from "../src/core/conversation.js";

// Canlıda (Postgres) test sohbeti geri alınan işlemde, yerelde bellekteki kopyada çalışır; ikisi de iz bırakmaz.
describe.each<SimulationMode>(["transaction", "copy"])("test sohbeti (%s)", (mode) => {
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
      ], { mode });
      expect(result.replies).toEqual(["İki iş günü."]);
      // Test geri alınsa da harcaması döner (panel bunu "test" olarak kaydeder).
      expect(result.usage).toMatchObject([{ agent: "lina", model: "test", apiCalls: 1, inputTokens: 10, outputTokens: 5 }]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(create.mock.calls)).toContain("Merhaba, hoş geldiniz.");
      expect(sendText).not.toHaveBeenCalled();
      expect(await source.db.select().from(messages)).toEqual([]);
      expect(await source.db.select().from(customers)).toEqual([]);
      expect(await source.db.select().from(agentRuns)).toEqual([]);
      expect(await source.db.select().from(whatsappAccounts)).toEqual([]);
    } finally { await source.close(); }
  }, 30000);

  it("başka konuşmaların kayıtlarını göstermez", async () => {
    const source = await openDatabase({});
    try {
      const [tenant] = await source.db.insert(tenants).values({ slug: "test", name: "Test" }).returning();
      await source.db.insert(agentRuns).values({ tenantId: tenant!.id, agent: "order", model: "m", input: "gerçek müşteri sorusu", output: "gizli" });
      const create = vi.fn(async () => ({
        id: "test", type: "message", role: "assistant", content: [{ type: "text", text: "Merhaba!", citations: null }],
        stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
      } as Anthropic.Message));
      const deps = { db: source.db, llm: { create }, wa: {}, model: "test", historyLimit: 20, timeZone: "Europe/Istanbul", log: console } as unknown as Deps;
      const result = await simulate(deps, tenant!.id, [{ role: "user", text: "Merhaba" }], { mode });
      expect(JSON.stringify(result.runs)).not.toContain("gerçek müşteri sorusu");
      expect(await source.db.select().from(agentRuns)).toHaveLength(1);
    } finally { await source.close(); }
  }, 30000);

  it("art arda müşteri mesajlarına tek cevap verir; hepsi Lina'ya tek yazı olarak gider", async () => {
    const source = await openDatabase({});
    try {
      const [tenant] = await source.db.insert(tenants).values({ slug: "test", name: "Test" }).returning();
      const create = vi.fn(async (_params: Anthropic.MessageCreateParams) => ({
        id: "test", type: "message", role: "assistant", content: [{ type: "text", text: "Siparişinize bakıyorum.", citations: null }],
        stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
      } as Anthropic.Message));
      const deps = { db: source.db, llm: { create }, wa: {}, model: "test", historyLimit: 20, timeZone: "Europe/Istanbul", log: console } as unknown as Deps;
      const result = await simulate(deps, tenant!.id, [
        { role: "user", text: "Merhaba" }, { role: "user", text: "siparişim gelmedi" }, { role: "user", text: "#1045" },
      ], { mode });
      expect(result.replies).toEqual(["Siparişinize bakıyorum."]);
      expect(create).toHaveBeenCalledTimes(1);
      const sent = create.mock.calls[0]![0].messages;
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0])).toContain("Merhaba\\nsiparişim gelmedi\\n#1045");
    } finally { await source.close(); }
  }, 30000);

  it("karar özeti: cevabın ekibe düşürdüğü bildirimi ve harcamasını döner, iz bırakmaz", async () => {
    const source = await openDatabase({});
    try {
      const [tenant] = await source.db.insert(tenants).values({ slug: "test", name: "Test" }).returning();
      const answer = (content: unknown[], stop: string) =>
        ({ id: "test", type: "message", role: "assistant", content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 100 } }) as unknown as Anthropic.Message;
      // Lina şikayeti sipariş uzmanına sorar (1. çağrı), uzman cevaplar (2.), Lina müşteriye yazar (3.).
      const create = vi.fn(async (params: Anthropic.MessageCreateParams) => {
        const tools = (params.tools ?? []).map((t) => ("name" in t ? t.name : ""));
        if (!tools.includes("ask_order_agent")) return answer([{ type: "text", text: "Sipariş doğrulandı; şikayet ekibe bildirilecek.", citations: null }], "end_turn");
        const last = params.messages.at(-1)!.content;
        if (Array.isArray(last) && last[0]?.type === "tool_result") return answer([{ type: "text", text: "Çok üzgünüm, hemen ilgileniyorum.", citations: null }], "end_turn");
        return answer(
          [{ type: "tool_use", id: "t1", name: "ask_order_agent", input: { topic: "complaint", question: "Ürün hasarlı geldi.", order_number: "MO-9001", customer_name: "", order_phone: "" } }],
          "tool_use",
        );
      });
      const deps = { db: source.db, llm: { create }, wa: {}, model: "claude-sonnet-5", historyLimit: 20, timeZone: "Europe/Istanbul", log: console } as unknown as Deps;
      const result = await simulate(deps, tenant!.id, [{ role: "user", text: "MO-9001 hasarlı geldi" }], { mode, demo: true });
      expect(result.replies).toEqual(["Çok üzgünüm, hemen ilgileniyorum."]);
      expect(result.notifications).toMatchObject([{ kind: "complaint", important: true, orderNames: [expect.stringContaining("MO-9001")] }]);
      const summary = replySummary(result.usage);
      expect(summary).toMatchObject({ apiCalls: 3, memoryCostUsd: null });
      // 3 çağrı × (1000 girdi × 2 $ + 100 çıktı × 10 $) / 1 milyon
      expect(summary.costUsd).toBeCloseTo(0.009, 6);
      expect(await source.db.select().from(notifications)).toEqual([]);
    } finally { await source.close(); }
  }, 30000);

  it("ekran isteği bırakınca (yeni mesaj yazıldı) cevap gönderilmez", async () => {
    const source = await openDatabase({});
    try {
      const [tenant] = await source.db.insert(tenants).values({ slug: "test", name: "Test" }).returning();
      const abort = new AbortController();
      abort.abort();
      const create = vi.fn();
      const deps = { db: source.db, llm: { create }, wa: {}, model: "test", historyLimit: 20, timeZone: "Europe/Istanbul", log: console } as unknown as Deps;
      const result = await simulate(deps, tenant!.id, [{ role: "user", text: "Merhaba" }], { signal: abort.signal, mode });
      expect(result).toMatchObject({ replies: [], outcome: "cancelled" });
    } finally { await source.close(); }
  }, 30000);
});

it("deneme siparişleri seçilmediyse canlıdaki gibi mağazanın sipariş bağlantısını kullanır", async () => {
  const source = await openDatabase({});
  try {
    const [tenant] = await source.db.insert(tenants).values({ slug: "test", name: "Test" }).returning();
    const create = vi.fn(async (_params: Anthropic.MessageCreateParams) => ({
      id: "test", type: "message", role: "assistant", content: [{ type: "text", text: "Merhaba!", citations: null }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
    } as Anthropic.Message));
    const orderSourceFor = vi.fn(async () => ({ byName: async () => null, byPhone: async () => [] }));
    const deps = { db: source.db, llm: { create }, wa: {}, model: "test", historyLimit: 20, timeZone: "Europe/Istanbul", log: console, orderSourceFor } as unknown as Deps;
    await simulate(deps, tenant!.id, [{ role: "user", text: "Merhaba" }], { mode: "transaction" });
    expect(orderSourceFor).toHaveBeenCalledWith(tenant!.id);
    const tools = create.mock.calls[0]![0].tools!.map((t) => ("name" in t ? t.name : ""));
    expect(tools).toContain("ask_order_agent");
    expect(tools).toContain("ask_returns_agent");
  } finally { await source.close(); }
}, 30000);
