import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { turnContext } from "../src/agents/prompts.js";
import type { Llm } from "../src/agents/runner.js";
import type { Deps } from "../src/core/conversation.js";
import { findStaleMemories, IdleMemoryScheduler, loadMemory, purgeExpiredMemories, updateMemory } from "../src/core/memory.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { agentRuns, conversations, customerMemories, customers, messages, tenants, whatsappAccounts, type Tenant } from "../src/db/schema.js";
import { simulate } from "../src/panel/simulator.js";

let database: Database;
let tenant: Tenant;

const toolReply = (input: unknown) =>
  ({
    id: "m",
    type: "message",
    role: "assistant",
    model: "haiku",
    content: [{ type: "tool_use", id: "t1", name: "save_memory", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;
const textReply = (text: string) =>
  ({
    id: "m",
    type: "message",
    role: "assistant",
    model: "x",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;

beforeAll(async () => {
  database = await openDatabase({});
  [tenant] = (await database.db.insert(tenants).values({ slug: "betulsaday", name: "Betül Saday" }).returning()) as [Tenant];
});
afterAll(() => database.close());

async function conversationWith(waId: string, lines: [("customer" | "bot"), string][]) {
  const [customer] = await database.db.insert(customers).values({ tenantId: tenant.id, waId }).returning();
  const [account] = await database.db
    .insert(whatsappAccounts)
    .values({ tenantId: tenant.id, phoneNumberId: `pn-${waId}`, accessTokenEnc: "x" })
    .returning();
  const [conversation] = await database.db
    .insert(conversations)
    .values({ tenantId: tenant.id, customerId: customer!.id, whatsappAccountId: account!.id })
    .returning();
  for (const [sender, text] of lines) {
    await database.db.insert(messages).values({ tenantId: tenant.id, conversationId: conversation!.id, sender, type: "text", text });
  }
  return { customerId: customer!.id, conversationId: conversation!.id };
}

describe("müşteri kartı", () => {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let next = "";
  const llm: Llm = {
    async create(params) {
      calls.push(params);
      return toolReply({ memory: next });
    },
  };
  const deps = () => ({ db: database.db, llm, model: "haiku" });
  const now = new Date("2026-10-02T09:00:00Z");
  beforeEach(() => {
    calls.length = 0;
  });

  it("konuşmadan kart yazılır; sonraki güncelleme yalnızca yeni mesajları okur; yeni mesaj yoksa çağrı yok", async () => {
    const { customerId, conversationId } = await conversationWith("905001112233", [
      ["customer", "Merhaba, ben Ayşe Yılmaz. MO-9013 iadem 50 gündür yatmadı"],
      ["bot", "Çok üzgünüm Ayşe Hanım... Talebiniz işleme alındı."],
    ]);
    next = "Ad soyad ve hitap: Ayşe Yılmaz (Ayşe Hanım)\nAçık konular:\n- MO-9013: iade parası bekliyor, 2 Ekim'de sordu, işleme alındı.";
    const input = { tenant, customerId, conversationId, now, timeZone: "Europe/Istanbul" };
    expect(await updateMemory(deps(), input)).toBe(next);
    expect(await loadMemory(database.db, customerId)).toBe(next);

    const first = calls[0]!;
    expect(first.model).toBe("haiku");
    expect(first.tool_choice).toEqual({ type: "tool", name: "save_memory" });
    const system = first.system as string;
    expect(system).toContain("Asla yazma: adres, ödeme ve kart bilgisi, IBAN");
    expect(first.messages[0]!.content as string).toContain("Müşteri: Merhaba, ben Ayşe Yılmaz");
    expect(first.messages[0]!.content as string).toContain("(henüz kart yok)");

    // Kart yazarının harcaması da kaydedilir (İstatistik).
    const [run] = (await database.db.select().from(agentRuns)).filter((r) => r.agent === "memory");
    expect(run).toMatchObject({ model: "haiku", conversationId, source: "live", apiCalls: 1 });

    // Yeni mesaj yok: model çağrılmaz.
    expect(await updateMemory(deps(), input)).toBe(next);
    expect(calls).toHaveLength(1);

    await database.db.insert(messages).values({ tenantId: tenant.id, conversationId, sender: "customer", type: "text", text: "Bir de 36 beden giyiyorum" });
    next = `${next}\nTercihler ve tarz: 36/38 beden.`;
    await updateMemory(deps(), input);
    const second = calls[1]!.messages[0]!.content as string;
    expect(second).toContain("Bir de 36 beden giyiyorum");
    expect(second).not.toContain("iadem 50 gündür yatmadı"); // eski mesajlar yeniden okunmaz
    expect(second).toContain("Ad soyad ve hitap: Ayşe Yılmaz"); // mevcut kart gider
  });

  it("son mesajdan 6 ay sonra kart silinir; müşteri silinince kart da silinir", async () => {
    const old = await conversationWith("905002223344", [["customer", "merhaba"]]);
    const fresh = await conversationWith("905003334455", [["customer", "merhaba"]]);
    await database.db.insert(customerMemories).values([
      { tenantId: tenant.id, customerId: old.customerId, text: "eski", lastActivityAt: new Date("2026-03-01T00:00:00Z") },
      { tenantId: tenant.id, customerId: fresh.customerId, text: "yeni", lastActivityAt: new Date("2026-09-01T00:00:00Z") },
    ]);
    expect(await purgeExpiredMemories(database.db, now)).toBe(1);
    expect(await loadMemory(database.db, old.customerId)).toBeNull();
    expect(await loadMemory(database.db, fresh.customerId)).toBe("yeni");

    await database.db.delete(customers).where(eq(customers.id, fresh.customerId));
    expect(await loadMemory(database.db, fresh.customerId)).toBeNull();
  });

  it("Lina kartı sessizce kullanır; kartı olan müşteriye yeniden tanıtım yapılmaz", () => {
    const context = turnContext(tenant, {
      firstContact: false,
      business: { open: true },
      openHandoff: null,
      memory: "Ad soyad ve hitap: Ayşe Yılmaz (Ayşe Hanım)",
    });
    expect(context).toContain("<kart>\nAd soyad ve hitap: Ayşe Yılmaz (Ayşe Hanım)\n</kart>");
    expect(context).toContain("Müşteriye hatırladığını belli etme");
    expect(context).toContain("doğrulama için uzmana customer_name olarak verirsin; tekrar sorma");
    expect(turnContext(tenant, { firstContact: false, business: { open: true }, openHandoff: null })).not.toContain("<kart>");
  });

  it("test ekranı: önceki kart Lina'ya gider, cevaptan sonra güncel kart döner; iz bırakmaz", async () => {
    const create = vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) =>
      params.tool_choice ? toolReply({ memory: "Ad soyad ve hitap: Ayşe Yılmaz\nTercihler ve tarz: kısa yazar." }) : textReply("Merhaba Ayşe Hanım, nasıl yardımcı olabilirim?"),
    );
    const source = {
      db: database.db,
      llm: { create },
      wa: {},
      model: "sonnet",
      historyLimit: 20,
      timeZone: "Europe/Istanbul",
      log: console,
      memory: { model: "haiku" },
    } as unknown as Deps;
    const before = await database.db.select().from(customerMemories);
    const result = await simulate(source, tenant.id, [{ role: "user", text: "merhaba" }], {
      mode: "transaction",
      memory: "Ad soyad ve hitap: Ayşe Yılmaz",
    });
    expect(result.memory).toBe("Ad soyad ve hitap: Ayşe Yılmaz\nTercihler ve tarz: kısa yazar.");
    const lina = create.mock.calls.find(([p]) => !p.tool_choice)![0];
    const context = (lina.system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
    expect(context).toContain("<kart>\nAd soyad ve hitap: Ayşe Yılmaz\n</kart>");
    expect(context).toContain("kendini yeniden tanıtma"); // kartı olan müşteri ilk kez yazmıyor
    expect(await database.db.select().from(customerMemories)).toEqual(before);
  }, 30000);

  it("kart müşteri susunca bir kez güncellenir; her cevap beklemeyi baştan başlatır; kapanışta hemen", () => {
    vi.useFakeTimers();
    try {
      const ran: string[] = [];
      const scheduler = new IdleMemoryScheduler((customerId, job) => { ran.push(customerId); void job(); }, 1000);
      const job = vi.fn(async () => {});
      scheduler.schedule("ayse", job);
      vi.advanceTimersByTime(800);
      scheduler.schedule("ayse", job); // yeni cevap: bekleme baştan
      vi.advanceTimersByTime(800);
      expect(ran).toEqual([]);
      vi.advanceTimersByTime(300);
      expect(ran).toEqual(["ayse"]);
      expect(job).toHaveBeenCalledTimes(1);

      scheduler.schedule("zeynep", job);
      expect(scheduler.size).toBe(1);
      scheduler.flush();
      expect(ran).toEqual(["ayse", "zeynep"]);
      expect(scheduler.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("açılışta kartı son mesajından geride kalan müşteriler bulunur", async () => {
    const behind = await conversationWith("905004445566", [["customer", "merhaba"]]);
    const upToDate = await conversationWith("905005556677", [["customer", "merhaba"]]);
    await database.db.insert(customerMemories).values({ tenantId: tenant.id, customerId: upToDate.customerId, text: "güncel", updatedAt: new Date(Date.now() + 60_000) });
    const stale = await findStaleMemories(database.db, new Date(Date.now() - 60 * 60 * 1000));
    const ids = stale.map((m) => m.customerId);
    expect(ids).toContain(behind.customerId);
    expect(ids).not.toContain(upToDate.customerId);
    expect(stale.find((m) => m.customerId === behind.customerId)).toMatchObject({ tenantId: tenant.id, conversationId: behind.conversationId });
  });
});
