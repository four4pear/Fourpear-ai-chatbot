import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { EventBus, type PanelEvent } from "../src/core/events.js";
import type { Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { agentRuns, conversations, customers, handoffs, memberships, messages, teamQuestions, tenants, users, whatsappAccounts } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { encryptSecret } from "../src/lib/crypto.js";

const ORIGIN = "http://panel.test";
const PASSWORD = "dogru-sifre-123";
const MASTER_KEY = randomBytes(32).toString("base64");

let database: Database;
let server: Server;
let base: string;
let tenantA: string;
let tenantB: string;
let now = new Date("2026-10-03T12:00:00Z");
let sendFails = false;
const sent: { to: string; text: string }[] = [];
const events: PanelEvent[] = [];
const cookies: Record<string, string> = {};
/** Lina'ya geri verilince cevap kurulur mu? (zamanlayıcı gerçek cevabı hazırlamaz) */
const replyRequests: string[] = [];
const ids: Record<string, string> = {};

async function call(who: "zeynep" | "ali" | "sahip", method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: cookies[who]! },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const conv = (suffix = "") => `/api/tenants/${tenantA}/conversations/${ids.conv}${suffix}`;
const row = async () => (await database.db.select().from(conversations).where(eq(conversations.id, ids.conv!)))[0]!;
const thread = () => database.db.select().from(messages).where(eq(messages.conversationId, ids.conv!)).orderBy(messages.createdAt, messages.seq);

beforeAll(async () => {
  database = await openDatabase({});
  const { db } = database;
  const bus = new EventBus();
  const [a, b] = await db.insert(tenants).values([{ slug: "maius", name: "MAIUS" }, { slug: "diger", name: "Diğer" }]).returning();
  tenantA = a!.id;
  tenantB = b!.id;
  bus.subscribe(tenantA, (e) => events.push(e));

  const hash = await hashPassword(PASSWORD);
  for (const [key, name, role] of [["zeynep", "Zeynep", "agent"], ["ali", "Ali", "agent"], ["sahip", "Serap", "owner"]] as const) {
    const [u] = await db.insert(users).values({ email: `${key}@maius.test`, name, passwordHash: hash }).returning();
    ids[key] = u!.id;
    await db.insert(memberships).values({ userId: u!.id, tenantId: tenantA, role });
  }
  const [acc] = await db.insert(whatsappAccounts).values({ tenantId: tenantA, phoneNumberId: "pn-a", accessTokenEnc: encryptSecret("token", MASTER_KEY) }).returning();
  ids.account = acc!.id;
  const [accB] = await db.insert(whatsappAccounts).values({ tenantId: tenantB, phoneNumberId: "pn-b", accessTokenEnc: encryptSecret("token", MASTER_KEY) }).returning();
  const [custB] = await db.insert(customers).values({ tenantId: tenantB, waId: "905320000000", name: "Fatma" }).returning();
  const [convB] = await db.insert(conversations).values({ tenantId: tenantB, customerId: custB!.id, whatsappAccountId: accB!.id }).returning();
  ids.other = convB!.id;

  const deps = { db, log: { info() {}, warn() {}, error() {} } } as unknown as Deps;
  const { app, scheduler } = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }, deps, undefined, {
    db,
    publicUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
    secureCookies: false,
    wa: {
      sendText: async ({ to, text }) => {
        if (sendFails) throw new Error("WhatsApp hatası");
        sent.push({ to, text });
        return [`wamid.${sent.length}`];
      },
      markReadAndTyping: async () => {},
      downloadMedia: async () => ({ data: Buffer.alloc(0), mimeType: "image/jpeg" }),
    },
    masterKey: MASTER_KEY,
    events: bus,
    now: () => now,
    log: { info() {}, warn() {}, error() {} },
  });
  vi.spyOn(scheduler, "onCustomerMessage").mockImplementation((conversationId) => { replyRequests.push(conversationId); });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const key of ["zeynep", "ali", "sahip"]) {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: `${key}@maius.test`, password: PASSWORD }),
    });
    cookies[key] = login.headers.get("set-cookie")!.split(";")[0]!;
  }
});

afterAll(async () => {
  server.close();
  await database.close();
});

// Her test: müşterinin temsilci istediği, Lina'nın devrettiği taze bir konuşma.
beforeEach(async () => {
  const { db } = database;
  now = new Date("2026-10-03T12:00:00Z");
  sendFails = false;
  sent.length = 0;
  events.length = 0;
  replyRequests.length = 0;
  await db.delete(customers).where(eq(customers.tenantId, tenantA));
  const [cust] = await db.insert(customers).values({ tenantId: tenantA, waId: "905321234567", name: "Ayşe" }).returning();
  const [c] = await db
    .insert(conversations)
    .values({ tenantId: tenantA, customerId: cust!.id, whatsappAccountId: ids.account!, status: "waiting", lastCustomerMessageAt: new Date("2026-10-03T11:50:00Z") })
    .returning();
  ids.conv = c!.id;
  await db.insert(messages).values({ tenantId: tenantA, conversationId: c!.id, sender: "customer", text: "Yetkiliyle görüşmek istiyorum" });
  await db.insert(handoffs).values({ tenantId: tenantA, conversationId: c!.id, reason: "customer_request", summary: "Temsilci istiyor." });
});

describe("panel: konuşmayı devralma, yazma, Lina'ya geri verme", () => {
  it("ilk tıklayan devralır: Lina susar, not düşer; başka çalışan alamaz, mağaza sahibi alabilir", async () => {
    expect((await call("zeynep", "POST", conv("/takeover"))).status).toBe(200);
    expect(await row()).toMatchObject({ status: "human", assignedUserId: ids.zeynep });
    expect((await thread()).at(-1)).toMatchObject({ sender: "system", type: "note", text: "Zeynep konuşmayı devraldı" });
    expect(events).toContainEqual({ type: "conversation", conversationId: ids.conv });

    // Aynı kişi tekrar tıklarsa ikinci not düşmez.
    expect((await call("zeynep", "POST", conv("/takeover"))).status).toBe(200);
    expect((await thread()).filter((m) => m.type === "note")).toHaveLength(1);

    const taken = await call("ali", "POST", conv("/takeover"));
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("Bu konuşmayı Zeynep devraldı.");
    expect((await row()).assignedUserId).toBe(ids.zeynep);

    expect((await call("sahip", "POST", conv("/takeover"))).status).toBe(200);
    expect((await row()).assignedUserId).toBe(ids.sahip);
    expect((await thread()).at(-1)!.text).toBe("Serap konuşmayı devraldı (önceki: Zeynep)");
  });

  it("yalnızca devralan yazabilir; mesaj müşteriye gider ve ekip mesajı olarak saklanır", async () => {
    const before = await call("zeynep", "POST", conv("/messages"), { text: "Merhaba" });
    expect(before.status).toBe(409);
    expect(before.body.error).toBe("Cevap yazmak için önce konuşmayı devralın.");

    await call("zeynep", "POST", conv("/takeover"));
    expect((await call("ali", "POST", conv("/messages"), { text: "Merhaba" })).status).toBe(409);
    expect((await call("zeynep", "POST", conv("/messages"), { text: "   " })).status).toBe(400);
    expect((await call("zeynep", "POST", conv("/messages"), { text: "a".repeat(4001) })).status).toBe(400);
    expect(sent).toEqual([]);

    expect((await call("zeynep", "POST", conv("/messages"), { text: " Merhaba Ayşe Hanım, hemen ilgileniyorum. " })).status).toBe(200);
    expect(sent).toEqual([{ to: "905321234567", text: "Merhaba Ayşe Hanım, hemen ilgileniyorum." }]);
    expect((await thread()).at(-1)).toMatchObject({ sender: "agent", type: "text", authorUserId: ids.zeynep, text: "Merhaba Ayşe Hanım, hemen ilgileniyorum.", waMessageId: "wamid.1" });

    const detail = await call("zeynep", "GET", conv());
    expect(detail.body.conversation).toMatchObject({ status: "human", canReply: true, assignedTo: { id: ids.zeynep, name: "Zeynep" } });
    expect(detail.body.messages.at(-1)).toMatchObject({ sender: "agent", author: { name: "Zeynep" }, sendError: null });
    // Başkası konuşmayı görür ama yazamaz.
    expect((await call("ali", "GET", conv())).body.conversation.canReply).toBe(false);
  });

  it("müşterinin son mesajından 24 saat geçtiyse yazılamaz (WhatsApp kuralı)", async () => {
    await call("zeynep", "POST", conv("/takeover"));
    now = new Date("2026-10-04T11:51:00Z");
    const late = await call("zeynep", "POST", conv("/messages"), { text: "Merhaba" });
    expect(late.status).toBe(422);
    expect(late.body.error).toContain("24 saat geçti");
    expect(sent).toEqual([]);
    expect((await call("zeynep", "GET", conv())).body.conversation.canReply).toBe(false);
  });

  it("WhatsApp'a gönderilemeyen mesaj hatasıyla saklanır, ekip görür", async () => {
    await call("zeynep", "POST", conv("/takeover"));
    sendFails = true;
    const failed = await call("zeynep", "POST", conv("/messages"), { text: "Merhaba" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("Mesaj WhatsApp'a gönderilemedi. Lütfen tekrar deneyin.");
    const detail = await call("zeynep", "GET", conv());
    expect(detail.body.messages.at(-1)).toMatchObject({ sender: "agent", text: "Merhaba" });
    expect(detail.body.messages.at(-1).sendError).toBeTruthy();
  });

  it("Lina'ya geri ver: devir çözülür, Lina yeniden cevaplar; başkasının konuşmasını çalışan geri veremez", async () => {
    await call("zeynep", "POST", conv("/takeover"));
    const denied = await call("ali", "POST", conv("/release"));
    expect(denied.status).toBe(403);
    expect((await row()).status).toBe("human");

    expect((await call("zeynep", "POST", conv("/release"))).status).toBe(200);
    expect(await row()).toMatchObject({ status: "bot", assignedUserId: null });
    expect((await thread()).at(-1)).toMatchObject({ type: "note", text: "Zeynep konuşmayı Lina'ya geri verdi" });
    const [handoff] = await database.db.select().from(handoffs).where(eq(handoffs.conversationId, ids.conv!));
    expect(handoff).toMatchObject({ status: "resolved", resolvedBy: ids.zeynep });
    // Geri verildikten sonra yazılamaz.
    expect((await call("zeynep", "POST", conv("/messages"), { text: "Merhaba" })).status).toBe(409);
  });

  it("Lina'ya geri verilince müşterinin cevapsız mesajı varsa Lina cevaplar; müşteri yeniden yazana kadar beklemez", async () => {
    await call("zeynep", "POST", conv("/takeover"));
    // Ekipteyken müşteri yazdı, kimse cevaplamadı.
    await database.db.insert(messages).values({ tenantId: tenantA, conversationId: ids.conv!, sender: "customer", text: "Orada mısınız?" });
    expect((await call("zeynep", "POST", conv("/release"))).status).toBe(200);
    expect(replyRequests).toEqual([ids.conv]);
  });

  it("ekipteyken müşterinin yeniden yazdığı konuşma Bekleyenler'de ve menü sayısında görünür; ekip cevaplayınca düşer", async () => {
    await call("zeynep", "POST", conv("/takeover"));
    const waiting = async () => (await call("ali", "GET", `/api/tenants/${tenantA}/conversations?view=waiting`)).body.conversations;
    const count = async () => (await call("ali", "GET", `/api/tenants/${tenantA}/waiting-count`)).body;
    // Devralındı ama müşterinin "Yetkiliyle görüşmek istiyorum" mesajı hâlâ cevapsız: sayıya girer.
    expect((await waiting()).map((c: any) => c.id)).toEqual([ids.conv]);
    expect((await count()).handoffs).toBe(1);
    const sentReply = await call("zeynep", "POST", conv("/messages"), { text: "Merhaba, ben Zeynep." });
    expect([sentReply.status, sentReply.body]).toEqual([200, { messageId: expect.any(String) }]);
    // Cevaplandı: sayıdan düşer; açık devir yüzünden listede kalır (devralınmışlar altta).
    expect((await count()).handoffs).toBe(0);
    expect((await waiting()).map((c: any) => c.id)).toEqual([ids.conv]);
    await database.db.update(handoffs).set({ status: "resolved" }).where(eq(handoffs.conversationId, ids.conv!));
    expect(await waiting()).toEqual([]);

    await database.db.insert(messages).values({ tenantId: tenantA, conversationId: ids.conv!, sender: "customer", text: "Orada mısınız?" });
    const [row] = await waiting();
    expect(row).toMatchObject({ id: ids.conv, status: "human", assignedTo: { name: "Zeynep" }, lastMessage: { sender: "customer", text: "Orada mısınız?" } });
    expect((await count()).handoffs).toBe(1);

    expect((await call("zeynep", "POST", conv("/messages"), { text: "Buradayım, bakıyorum." })).status).toBe(200);
    expect(await waiting()).toEqual([]);
    expect((await count()).handoffs).toBe(0);
  });

  it("kimse devralmadıysa herhangi bir ekip üyesi Lina'ya geri verebilir; sahip başkasınınkini de verir", async () => {
    expect((await call("ali", "POST", conv("/release"))).status).toBe(200);
    expect((await row()).status).toBe("bot");

    await call("zeynep", "POST", conv("/takeover"));
    expect((await call("sahip", "POST", conv("/release"))).status).toBe(200);
    expect(await row()).toMatchObject({ status: "bot", assignedUserId: null });
  });

  it("liste: ad ya da telefonla aranır, 'Bende' yalnızca benim devraldıklarımı gösterir", async () => {
    const { db } = database;
    const [other] = await db.insert(customers).values({ tenantId: tenantA, waId: "905339876543", name: "Zehra Demir" }).returning();
    await db.insert(conversations).values({ tenantId: tenantA, customerId: other!.id, whatsappAccountId: ids.account! });
    const list = async (who: "zeynep" | "ali", query: string) =>
      (await call(who, "GET", `/api/tenants/${tenantA}/conversations?${query}`)).body.conversations.map((c: any) => c.customer.name);
    expect((await list("zeynep", "view=all")).sort()).toEqual(["Ayşe", "Zehra Demir"]);
    expect(await list("zeynep", "view=all&q=zehra")).toEqual(["Zehra Demir"]);
    expect(await list("zeynep", "view=all&q=AYŞ")).toEqual(["Ayşe"]);
    expect(await list("zeynep", `view=all&q=${encodeURIComponent("0533 987")}`)).toEqual(["Zehra Demir"]);
    expect(await list("zeynep", "view=all&q=yok")).toEqual([]);
    // Joker karakterler arama metni olarak kalır.
    expect(await list("zeynep", `view=all&q=${encodeURIComponent("%")}`)).toEqual([]);

    await call("zeynep", "POST", conv("/takeover"));
    expect(await list("zeynep", "view=mine")).toEqual(["Ayşe"]);
    expect(await list("ali", "view=mine")).toEqual([]);
  });

  it("konuşma ayrıntısı: Lina'nın açık sorusu görünür; müşteri kartı çalışması uzman çağrısı sayılmaz", async () => {
    const { db } = database;
    await db.insert(teamQuestions).values([
      { tenantId: tenantA, conversationId: ids.conv!, question: "Hediye paketi var mı?" },
      { tenantId: tenantA, conversationId: ids.conv!, question: "Eski soru", status: "answered", answer: "Evet" },
    ]);
    await db.insert(agentRuns).values([
      { tenantId: tenantA, conversationId: ids.conv!, agent: "lina", model: "m" },
      { tenantId: tenantA, conversationId: ids.conv!, agent: "memory", model: "m" },
      { tenantId: tenantA, conversationId: ids.conv!, agent: "returns", model: "m", input: "İade?", output: "14 gün." },
    ]);
    const { body } = await call("zeynep", "GET", conv());
    expect(body.teamQuestions).toMatchObject([{ question: "Hediye paketi var mı?" }]);
    expect(body.expertCalls).toMatchObject([{ agent: "returns", question: "İade?", answer: "14 gün." }]);
  });

  it("başka mağazanın konuşması devralınamaz, yazılamaz, geri verilemez", async () => {
    const other = `/api/tenants/${tenantA}/conversations/${ids.other}`;
    expect((await call("sahip", "POST", `${other}/takeover`)).status).toBe(404);
    expect((await call("sahip", "POST", `${other}/messages`, { text: "Merhaba" })).status).toBe(404);
    expect((await call("sahip", "POST", `${other}/release`)).status).toBe(404);
    expect((await call("sahip", "GET", other)).status).toBe(404);
    expect((await call("sahip", "POST", `/api/tenants/${tenantB}/conversations/${ids.other}/takeover`)).status).toBe(404);
  });
});
