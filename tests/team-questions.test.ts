import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { turnContext } from "../src/agents/prompts.js";
import type { Llm } from "../src/agents/runner.js";
import { EventBus, type PanelEvent } from "../src/core/events.js";
import type { Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { hashPassword } from "../src/auth/password.js";
import { encryptSecret } from "../src/lib/crypto.js";
import {
  conversations,
  customers,
  lessons,
  memberships,
  messages,
  teamQuestions,
  tenants,
  users,
  whatsappAccounts,
  type Tenant,
} from "../src/db/schema.js";
import { simulate } from "../src/panel/simulator.js";

const ORIGIN = "http://panel.test";
const PASSWORD = "dogru-sifre-123";
const MASTER_KEY = randomBytes(32).toString("base64");

const message = (content: unknown[], stop: string) =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Anthropic.Message;
const textOf = (content: Anthropic.MessageParam["content"]) =>
  typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? String(b.content) : "")).join(" ");

/**
 * Sahte Lina: bilmediği soruda ask_team çağırır ve "kontrol ediyorum" der; geçmişte ekibin iç bilgisi
 * varsa onu müşteriye iletir.
 */
const linaCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];
const llm: Llm = {
  async create(params) {
    linaCalls.push(structuredClone(params));
    const last = params.messages.at(-1)!;
    const blocks = last.content as Anthropic.ContentBlockParam[];
    if (blocks[0]?.type === "tool_result") return message([{ type: "text", text: "Hemen kontrol ediyorum, kısa süre içinde size buradan bilgi vereceğim.", citations: null }], "end_turn");
    const text = textOf(last.content);
    const inside = /Ekibin cevabı: (.*)/.exec(text);
    if (inside) return message([{ type: "text", text: `Kontrol ettim: ${inside[1]}`, citations: null }], "end_turn");
    return message(
      [{ type: "tool_use", id: "t1", name: "ask_team", input: { question: "Hediye paketi yapıyor musunuz?", context: "Müşteri doğum günü hediyesi alacak." } }],
      "tool_use",
    );
  },
};

let database: Database;
let tenant: Tenant;

beforeAll(async () => {
  database = await openDatabase({});
  [tenant] = (await database.db.insert(tenants).values({ slug: "betulsaday", name: "Betül Saday" }).returning()) as [Tenant];
});
afterAll(() => database.close());

describe("Lina soruyor", () => {
  it("bilmediği bilgide konuşmayı devretmez, arka planda sorar; testte ekip cevabı müşteriye iletilir", async () => {
    linaCalls.length = 0;
    const source = { db: database.db, llm, wa: {}, model: "m", historyLimit: 20, timeZone: "Europe/Istanbul", log: console } as unknown as Deps;
    const first = await simulate(source, tenant.id, [{ role: "user", text: "Hediye paketi yapıyor musunuz?" }], { mode: "transaction" });
    expect(first.replies).toEqual(["Hemen kontrol ediyorum, kısa süre içinde size buradan bilgi vereceğim."]);
    expect(first.teamQuestions).toEqual([{ question: "Hediye paketi yapıyor musunuz?", context: "Müşteri doğum günü hediyesi alacak." }]);
    expect(first.handoffs).toEqual([]);

    linaCalls.length = 0;
    const second = await simulate(
      source,
      tenant.id,
      [
        { role: "user", text: "Hediye paketi yapıyor musunuz?" },
        { role: "assistant", text: first.replies[0]! },
        { role: "team", question: "Hediye paketi yapıyor musunuz?", text: "Evet, ücretsiz; sipariş notuna yazılması yeterli." },
      ],
      { mode: "transaction" },
    );
    expect(second.outcome).toBe("replied");
    expect(second.replies).toEqual(["Kontrol ettim: Evet, ücretsiz; sipariş notuna yazılması yeterli."]);
    const lastUser = textOf(linaCalls[0]!.messages.at(-1)!.content);
    expect(lastUser).toContain("[İç bilgi, müşteri görmez: ekibe sorduğun sorunun cevabı geldi]");
    expect(await database.db.select().from(teamQuestions)).toEqual([]); // test iz bırakmaz
  }, 30000);

  it("cevabı beklenen soru Lina'ya hatırlatılır; aynı şeyi yeniden sormaz", () => {
    const context = turnContext(tenant, { firstContact: false, business: { open: true }, openHandoff: null, askedTeam: ["Hediye paketi var mı?"] });
    expect(context).toContain('Ekibe sorduğun, cevabı henüz gelmeyen soru(lar): "Hediye paketi var mı?"');
    expect(context).toContain("aynı soruyu ekibe yeniden sorma");
  });
});

describe("Bekleyenler: ekip cevaplar, Lina müşteriye iletir", () => {
  let server: Server;
  let base: string;
  const sent: string[] = [];
  const events: PanelEvent[] = [];
  let created: ReturnType<typeof createApp>;
  let ownerCookie: string;
  let agentCookie: string;
  let conversationId: string;

  async function login(email: string, role: "owner" | "agent") {
    const [user] = await database.db.insert(users).values({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD) }).returning();
    await database.db.insert(memberships).values({ userId: user!.id, tenantId: tenant.id, role });
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  const call = async (method: string, path: string, cookie: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: ORIGIN, cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    const bus = new EventBus();
    bus.subscribe(tenant.id, (e) => events.push(e));
    const deps: Deps = {
      db: database.db,
      llm,
      wa: { sendText: async ({ text }) => { sent.push(text); return ["wamid.x"]; }, markReadAndTyping: async () => {}, downloadMedia: async () => ({ data: Buffer.alloc(0), mimeType: "image/jpeg" }) },
      model: "m",
      masterKey: MASTER_KEY,
      historyLimit: 20,
      timeZone: "Europe/Istanbul",
      log: { info() {}, warn() {}, error() {} },
      events: bus,
    };
    created = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }, deps, undefined, {
      db: database.db,
      publicUrl: ORIGIN,
      allowedOrigins: [ORIGIN],
      secureCookies: false,
      wa: deps.wa,
      masterKey: MASTER_KEY,
      events: bus,
      log: { info() {}, warn() {}, error() {} },
    });
    server = created.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ownerCookie = await login("sahip@betulsaday.test", "owner");
    agentCookie = await login("calisan@betulsaday.test", "agent");

    const [customer] = await database.db.insert(customers).values({ tenantId: tenant.id, waId: "905001112233", name: "Ayşe" }).returning();
    const [account] = await database.db.insert(whatsappAccounts).values({ tenantId: tenant.id, phoneNumberId: "pn", accessTokenEnc: encryptSecret("t", MASTER_KEY) }).returning();
    const [conversation] = await database.db
      .insert(conversations)
      .values({ tenantId: tenant.id, customerId: customer!.id, whatsappAccountId: account!.id })
      .returning();
    conversationId = conversation!.id;
    await database.db.insert(messages).values([
      { tenantId: tenant.id, conversationId, sender: "customer", type: "text", text: "Hediye paketi yapıyor musunuz?" },
      { tenantId: tenant.id, conversationId, sender: "bot", type: "text", text: "Hemen kontrol ediyorum, kısa süre içinde size buradan bilgi vereceğim." },
    ]);
  });
  afterAll(() => server.close());

  async function ask(question: string) {
    const [q] = await database.db
      .insert(teamQuestions)
      .values({ tenantId: tenant.id, conversationId, question, context: "Doğum günü hediyesi", customerMessage: question })
      .returning();
    return q!.id;
  }

  it("ekip listeyi görür, cevaplar; cevap iç bilgi olarak eklenir ve Lina müşteriye iletir", async () => {
    const id = await ask("Hediye paketi yapıyor musunuz?");
    const list = await call("GET", `/api/tenants/${tenant.id}/team-questions`, agentCookie);
    expect(list.body.questions).toMatchObject([{ id, question: "Hediye paketi yapıyor musunuz?", customer: { name: "Ayşe" }, status: "open" }]);

    // Çalışan cevaplayabilir ama öğretemez (ders bütün konuşmaları etkiler).
    const res = await call("POST", `/api/tenants/${tenant.id}/team-questions/${id}/answer`, agentCookie, { answer: "Evet, ücretsiz.", teach: true });
    expect(res.body).toMatchObject({ ok: true, taught: false, windowClosed: false });
    await created.scheduler.idle();
    expect(sent.at(-1)).toBe("Kontrol ettim: Evet, ücretsiz.");
    const internal = await database.db.select().from(messages).where(eq(messages.type, "team_answer"));
    expect(internal.map((m) => m.text)).toEqual(["Soru: Hediye paketi yapıyor musunuz?\nEkibin cevabı: Evet, ücretsiz."]);
    expect(await database.db.select().from(lessons)).toEqual([]);
    expect(events.some((e) => e.type === "team_question")).toBe(true);

    // Aynı soru iki kez cevaplanamaz.
    expect((await call("POST", `/api/tenants/${tenant.id}/team-questions/${id}/answer`, ownerCookie, { answer: "x" })).status).toBe(409);
    const answered = await call("GET", `/api/tenants/${tenant.id}/team-questions?status=answered`, ownerCookie);
    expect(answered.body.questions[0]).toMatchObject({ answer: "Evet, ücretsiz.", answeredBy: { name: "calisan" } });
  });

  it("mağaza sahibi 'Lina'ya öğret' derse cevap ders olur", async () => {
    const id = await ask("Kapıda ödeme var mı?");
    const res = await call("POST", `/api/tenants/${tenant.id}/team-questions/${id}/answer`, ownerCookie, { answer: "Hayır, yalnızca kartla ödeme.", teach: true });
    expect(res.body).toMatchObject({ ok: true, taught: true });
    await created.scheduler.idle();
    const [lesson] = await database.db.select().from(lessons);
    expect(lesson).toMatchObject({ text: "Kapıda ödeme var mı? → Hayır, yalnızca kartla ödeme.", source: "team" });
  });

  it("boş cevap ve başka mağazanın sorusu reddedilir", async () => {
    const id = await ask("Mağazanız nerede?");
    expect((await call("POST", `/api/tenants/${tenant.id}/team-questions/${id}/answer`, ownerCookie, { answer: "  " })).status).toBe(400);
    const [other] = await database.db.insert(tenants).values({ slug: "diger", name: "Diğer" }).returning();
    // Bu kullanıcı diğer mağazanın üyesi değil.
    expect((await call("POST", `/api/tenants/${other!.id}/team-questions/${id}/answer`, ownerCookie, { answer: "x" })).status).toBe(404);
  });
});
