import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { linaSystemPrompt } from "../src/agents/prompts.js";
import type { Llm } from "../src/agents/runner.js";
import { EventBus } from "../src/core/events.js";
import type { Deps } from "../src/core/conversation.js";
import { loadLessons, withLessons } from "../src/core/lessons.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { agentRuns, lessons, memberships, tenants, users, type Tenant } from "../src/db/schema.js";
import { costUsd } from "../src/core/pricing.js";
import { hashPassword } from "../src/auth/password.js";

const ORIGIN = "http://panel.test";
const PASSWORD = "dogru-sifre-123";

let database: Database;
let tenant: Tenant;
let other: Tenant;
/** Eğitmene giden son istek ve vereceği öneri. */
let lastTrainerCall: Anthropic.MessageCreateParamsNonStreaming | null = null;
let proposal: { summary: string; lessons: string[]; replaces: string[] } = { summary: "", lessons: [], replaces: [] };

const llm: Llm = {
  async create(params) {
    lastTrainerCall = params;
    return {
      id: "m",
      type: "message",
      role: "assistant",
      model: "x",
      content: [{ type: "tool_use", id: "t1", name: "propose_lessons", input: proposal }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message;
  },
};

let call: (method: string, path: string, opts?: { body?: unknown; cookie?: string }) => Promise<{ status: number; body: Record<string, any> }>;
let server: Server;
let ownerCookie: string;
let agentCookie: string;

async function loginAs(email: string, memberOf: [string, "owner" | "agent"]) {
  const [user] = await database.db.insert(users).values({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD) }).returning();
  await database.db.insert(memberships).values({ userId: user!.id, tenantId: memberOf[0], role: memberOf[1] });
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

beforeAll(async () => {
  database = await openDatabase({});
  [tenant, other] = (await database.db
    .insert(tenants)
    .values([
      { slug: "betulsaday", name: "Betül Saday" },
      { slug: "diger", name: "Diğer" },
    ])
    .returning()) as [Tenant, Tenant];
  const deps = { db: database.db, llm, model: "m", log: { info() {}, warn() {}, error() {} } } as unknown as Deps;
  const { app } = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }, deps, undefined, {
    db: database.db,
    publicUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
    secureCookies: false,
    wa: { sendText: async () => [], markReadAndTyping: async () => {}, downloadMedia: async () => ({ data: Buffer.alloc(0), mimeType: "image/jpeg" }) },
    masterKey: Buffer.alloc(32).toString("base64"),
    events: new EventBus(),
    log: { info() {}, warn() {}, error() {} },
  });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  call = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  ownerCookie = await loginAs("sahip@betulsaday.test", [tenant.id, "owner"]);
  agentCookie = await loginAs("calisan@betulsaday.test", [tenant.id, "agent"]);
});
afterAll(async () => {
  server.close();
  await database.close();
});

describe("Lina'yı eğitmek", () => {
  const url = () => `/api/tenants/${tenant.id}`;
  const conversation = [
    { role: "user", text: "İadem ne zaman yatar?" },
    { role: "assistant", text: "Kaynaklarımızda tutarsızlık var, ekibe ilettim." },
  ];

  it("geri bildirim kurala çevrilir; hiçbir şey kaydedilmez; yalnızca mağaza sahibi", async () => {
    proposal = { summary: "Anladım: iade süresi doğrudan söylenecek.", lessons: ["Müşteri iade süresini sorduğunda: inceleme en geç 14 gün."], replaces: [] };
    const feedback = "iade süresini direkt söyle, tutarsızlık deme";
    expect((await call("POST", `${url()}/test/feedback`, { cookie: agentCookie, body: { history: conversation, feedback } })).status).toBe(403);
    const res = await call("POST", `${url()}/test/feedback`, { cookie: ownerCookie, body: { history: conversation, feedback } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: proposal.summary, lessons: proposal.lessons, replaces: [] });
    const sent = lastTrainerCall!.messages[0]!.content as string;
    expect(sent).toContain("Lina: Kaynaklarımızda tutarsızlık var");
    expect(sent).toContain(feedback);
    expect(lastTrainerCall!.tool_choice).toEqual({ type: "tool", name: "propose_lessons" });
    expect(await database.db.select().from(lessons)).toHaveLength(0);
  });

  it("onaylanan kural kaydedilir, listelenir; yenisi eskisinin yerine geçer; silinir", async () => {
    const first = await call("POST", `${url()}/lessons`, { cookie: ownerCookie, body: { texts: ["İade: inceleme en geç 14 gün."], feedback: "fb" } });
    expect(first.status).toBe(201);
    const oldId = first.body.lessons[0].id as string;

    // Eğitmen mevcut dersi görür ve yerine geçeceğini söyleyebilir (başka mağazanın dersi değiştirilemez).
    proposal = { summary: "Anladım.", lessons: ["İade: inceleme en geç 14 gün, bankaya iade 14-30 gün."], replaces: [oldId, "yok-boyle-bir-ders"] };
    const proposed = await call("POST", `${url()}/test/feedback`, { cookie: ownerCookie, body: { history: [], feedback: "banka süresini de ekle" } });
    expect(proposed.body.replaces).toEqual([{ id: oldId, text: "İade: inceleme en geç 14 gün." }]);
    expect(lastTrainerCall!.messages[0]!.content as string).toContain(`[${oldId}] İade: inceleme en geç 14 gün.`);

    const second = await call("POST", `${url()}/lessons`, {
      cookie: ownerCookie,
      body: { texts: proposed.body.lessons, replaces: [oldId] },
    });
    expect(second.status).toBe(201);
    const listed = await call("GET", `${url()}/lessons`, { cookie: ownerCookie });
    expect(listed.body.lessons.map((l: { text: string }) => l.text)).toEqual(["İade: inceleme en geç 14 gün, bankaya iade 14-30 gün."]);
    expect(listed.body.lessons[0].createdBy).toBe("sahip");

    // Başka mağazanın adresinden silinemez; çalışan silemez.
    const id = listed.body.lessons[0].id as string;
    expect((await call("DELETE", `/api/tenants/${other.id}/lessons/${id}`, { cookie: ownerCookie })).status).toBe(404);
    expect((await call("DELETE", `${url()}/lessons/${id}`, { cookie: agentCookie })).status).toBe(403);
    expect((await call("DELETE", `${url()}/lessons/${id}`, { cookie: ownerCookie })).status).toBe(200);
    expect(await loadLessons(database.db, tenant.id)).toEqual([]);
  });

  it("deneme siparişleri listesi: her senaryo örnek mesajıyla; yalnızca mağaza sahibi", async () => {
    expect((await call("GET", `${url()}/test/demo-orders`, { cookie: agentCookie })).status).toBe(403);
    const res = await call("GET", `${url()}/test/demo-orders`, { cookie: ownerCookie });
    expect(res.body.scenarios).toHaveLength(14);
    expect(res.body.scenarios.find((s: { order: string }) => s.order === "MO-9013")).toMatchObject({ sample: "MO-9013 iadem 50 gündür yatmadı" });
  });

  it("eğitmenin harcaması test olarak kaydedilir; İstatistik canlı ve testi ayrı, cevap başına gösterir", async () => {
    const trainerRuns = (await database.db.select().from(agentRuns)).filter((r) => r.agent === "trainer");
    expect(trainerRuns.length).toBeGreaterThan(0);
    expect(trainerRuns.every((r) => r.source === "test")).toBe(true);

    await database.db.delete(agentRuns);
    await database.db.insert(agentRuns).values([
      { tenantId: tenant.id, agent: "lina", model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, cacheWriteTokens: 0, source: "live" },
      { tenantId: tenant.id, agent: "returns", model: "claude-sonnet-5", inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 8000, source: "live" },
      { tenantId: tenant.id, agent: "memory", model: "claude-haiku-4-5-20251001", inputTokens: 1500, outputTokens: 200, source: "test" },
    ]);
    expect((await call("GET", `${url()}/usage?days=7`, { cookie: agentCookie })).status).toBe(403);
    const res = await call("GET", `${url()}/usage?days=7`, { cookie: ownerCookie });
    const live = res.body.totals.find((t: { source: string }) => t.source === "live");
    // Lina: 1000×2 + 9000×0,2 + 500×10 = 8.800 µ$; İade: 2000×2 + 8000×2,5 + 300×10 = 27.000 µ$
    expect(live.costUsd).toBeCloseTo(0.0358, 6);
    expect(live.replies).toBe(1);
    expect(live.perReplyUsd).toBeCloseTo(0.0358, 6);
    expect(live.cacheHitRate).toBeCloseTo(9000 / 20000, 6);
    expect(res.body.totals.find((t: { source: string }) => t.source === "test").costUsd).toBeCloseTo(0.0025, 6);
    expect(costUsd("bilinmeyen-model", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it("ders düzenlenir; boş metin, başka mağaza ve çalışan reddedilir", async () => {
    const created = await call("POST", `${url()}/lessons`, { cookie: ownerCookie, body: { texts: ["İlk hali."] } });
    const id = created.body.lessons[0].id as string;
    expect((await call("PATCH", `${url()}/lessons/${id}`, { cookie: agentCookie, body: { text: "x" } })).status).toBe(403);
    expect((await call("PATCH", `${url()}/lessons/${id}`, { cookie: ownerCookie, body: { text: "  " } })).status).toBe(400);
    expect((await call("PATCH", `/api/tenants/${other.id}/lessons/${id}`, { cookie: ownerCookie, body: { text: "x" } })).status).toBe(404);
    const edited = await call("PATCH", `${url()}/lessons/${id}`, { cookie: ownerCookie, body: { text: " Düzenlenmiş hali. " } });
    expect(edited.body.lesson).toEqual({ id, text: "Düzenlenmiş hali." });
    expect(await loadLessons(database.db, tenant.id)).toContain("Düzenlenmiş hali.");
  });

  it("boş ya da çok uzun kural kaydedilmez", async () => {
    expect((await call("POST", `${url()}/lessons`, { cookie: ownerCookie, body: { texts: [" "] } })).status).toBe(400);
    expect((await call("POST", `${url()}/lessons`, { cookie: ownerCookie, body: { texts: ["x".repeat(1001)] } })).status).toBe(400);
  });

  it("dersler Lina'nın talimatına ve uzmanların mağaza notlarına öncelikli olarak girer", () => {
    const taught = ["Müşteri iade süresini sorduğunda: inceleme en geç 14 gün."];
    const system = linaSystemPrompt(tenant, [], { orders: false, lessons: taught });
    expect(system).toContain("## Mağazanın sana öğrettikleri");
    expect(system).toContain(`- ${taught[0]}`);
    expect(linaSystemPrompt(tenant, [], { orders: false })).not.toContain("öğrettikleri");

    const kb = withLessons({ notes: "Bu hafta kargo gecikmeli.", core: [], legal: [] }, taught)!;
    expect(kb.notes).toContain("Bu hafta kargo gecikmeli.");
    expect(kb.notes).toContain(`Mağazanın öğrettikleri (mağaza sahibi onayladı; kaynaklardan önce gelir):\n- ${taught[0]}`);
    // Mağazanın hiç bilgi kaynağı yoksa da dersler uzmanlara gider.
    expect(withLessons(null, taught)!.notes).toContain(taught[0]);
    expect(withLessons(null, [])).toBeNull();
  });
});
