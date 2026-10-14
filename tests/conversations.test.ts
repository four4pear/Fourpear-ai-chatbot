import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { EventBus, type PanelEvent } from "../src/core/events.js";
import type { Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { agentRuns, conversations, customerMemories, customers, handoffs, knowledgeAlerts, media, memberships, messages, notifications, teamQuestions, tenants, users, whatsappAccounts } from "../src/db/schema.js";
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

  it("ayarlar: yalnızca sahip Lina'yı kapatıp açabilir; kapalıyken ayar kalıcıdır", async () => {
    const url = `/api/tenants/${tenantA}/settings`;
    expect((await call("zeynep", "GET", url)).status).toBe(403);
    expect((await call("zeynep", "PATCH", url, { botEnabled: false })).status).toBe(403);
    expect((await call("sahip", "PATCH", url, { botEnabled: "evet" })).status).toBe(400);
    expect((await call("sahip", "GET", url)).body).toMatchObject({ botEnabled: true, botHoursOnly: false });
    expect((await call("sahip", "PATCH", url, { botEnabled: false })).body).toMatchObject({ botEnabled: false });
    expect((await call("sahip", "GET", url)).body).toMatchObject({ botEnabled: false });
    const [t] = await database.db.select().from(tenants).where(eq(tenants.id, tenantA));
    expect(t!.settings).toMatchObject({ botEnabled: false, dailyMessageLimit: 200 }); // diğer ayarlar korunur
    expect((await call("sahip", "PATCH", url, { botEnabled: true })).body).toMatchObject({ botEnabled: true });

    // Mesai saatleri: doğrulanır, sıralanır, "yalnızca mesai saatlerinde" ayrı açılır.
    const hours = (h: unknown) => call("sahip", "PATCH", url, { businessHours: h });
    expect((await hours({ days: [], start: "10:00", end: "18:00" })).status).toBe(400);
    expect((await hours({ days: [1, 7], start: "10:00", end: "18:00" })).status).toBe(400);
    expect((await hours({ days: [1], start: "18:00", end: "10:00" })).status).toBe(400);
    expect((await hours({ days: [1], start: "10:00", end: "25:00" })).status).toBe(400);
    expect((await call("sahip", "PATCH", url, {})).status).toBe(400);
    expect((await hours({ days: [6, 1, 1, 2], start: "10:00", end: "18:00" })).body).toMatchObject({ businessHours: { days: [1, 2, 6], start: "10:00", end: "18:00" } });
    expect((await call("sahip", "PATCH", url, { botHoursOnly: true })).body).toMatchObject({ botHoursOnly: true, businessHours: { start: "10:00" } });
  });

  it("ayarlar: notlar, sabit metinler, cevap hızı, sınırlar ve iade el kitabı doğrulanır ve kaydedilir; boş metin hazır metne döner", async () => {
    const url = `/api/tenants/${tenantA}/settings`;
    const patch = (body: unknown) => call("sahip", "PATCH", url, body);
    expect((await call("zeynep", "PATCH", url, { notes: "x" })).status).toBe(403);

    const first = await patch({
      notes: "  Bu hafta kargoda gecikme var.  ",
      texts: { failure: "  Şu an cevap veremiyorum, ekip dönecek.  " },
      returnsPlaybook: "Önce dinle.",
      replyDelaySeconds: 20, maxReplyWaitSeconds: 120, dailyMessageLimit: 100, dailyStoreMessageLimit: 1500,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      notes: "Bu hafta kargoda gecikme var.",
      texts: { unsupported: "", failure: "Şu an cevap veremiyorum, ekip dönecek." },
      returnsPlaybook: "Önce dinle.",
      limits: { replyDelaySeconds: 20, maxReplyWaitSeconds: 120, dailyMessageLimit: 100, dailyStoreMessageLimit: 1500 },
    });
    expect(first.body.defaultTexts.failure).toContain("Üzgünüm");
    // Kalıcı: tenants.notes sütununda ve ayarlarda; Lina bunları okur.
    const [t] = await database.db.select().from(tenants).where(eq(tenants.id, tenantA));
    expect(t!.notes).toBe("Bu hafta kargoda gecikme var.");
    expect(t!.settings).toMatchObject({ dailyMessageLimit: 100, replyDelaySeconds: 20, texts: { failure: "Şu an cevap veremiyorum, ekip dönecek." }, botEnabled: true });

    // Boş metin hazır metne döner; diğer metin korunur.
    expect((await patch({ texts: { unsupported: "Yazar mısınız?" } })).body.texts).toEqual({ unsupported: "Yazar mısınız?", failure: "Şu an cevap veremiyorum, ekip dönecek." });
    expect((await patch({ texts: { failure: "  " } })).body.texts).toEqual({ unsupported: "Yazar mısınız?", failure: "" });

    // Geçersizler reddedilir ve hiçbir şey değişmez.
    for (const bad of [
      { dailyMessageLimit: 5 }, { dailyMessageLimit: 2.5 }, { dailyMessageLimit: "100" }, { dailyStoreMessageLimit: 10 },
      { replyDelaySeconds: -1 }, { replyDelaySeconds: 500 }, { maxReplyWaitSeconds: 5 },
      { replyDelaySeconds: 100, maxReplyWaitSeconds: 50 }, // bekleme, en fazla beklemeden uzun olamaz
      { notes: "x".repeat(8001) }, { returnsPlaybook: "x".repeat(20_001) }, { notes: 5 },
      { texts: { failure: "x".repeat(501) } }, { texts: { baska: "x" } }, { texts: ["x"] },
    ]) expect((await patch(bad)).status).toBe(400);
    const [after] = await database.db.select().from(tenants).where(eq(tenants.id, tenantA));
    expect(after!.settings).toMatchObject({ dailyMessageLimit: 100, replyDelaySeconds: 20, maxReplyWaitSeconds: 120 });
    expect(after!.notes).toBe("Bu hafta kargoda gecikme var.");

    // Sonraki testler varsayılan ayarlarla çalışsın.
    await patch({ notes: "", texts: { unsupported: "", failure: "" }, returnsPlaybook: "", replyDelaySeconds: 30, maxReplyWaitSeconds: 180, dailyMessageLimit: 200, dailyStoreMessageLimit: 3000 });
  });

  it("ayarlar: teslimat süresi kuralı doğrulanır, kaydedilir ve null ile kaldırılır", async () => {
    const url = `/api/tenants/${tenantA}/settings`;
    const patch = (body: unknown) => call("sahip", "PATCH", url, body);
    expect((await call("sahip", "GET", url)).body.deliveryDays).toBeNull();
    expect((await patch({ deliveryDays: { min: 7, max: 14 } })).body).toMatchObject({ deliveryDays: { min: 7, max: 14 }, deliveryRange: [1, 90] });
    const [t] = await database.db.select().from(tenants).where(eq(tenants.id, tenantA));
    expect(t!.settings).toMatchObject({ deliveryDays: { min: 7, max: 14 } });
    for (const bad of [{ min: 14, max: 7 }, { min: 0, max: 5 }, { min: 1, max: 91 }, { min: 2.5, max: 9 }, { min: "7", max: "14" }, { min: 7 }, "7-14", []]) {
      expect((await patch({ deliveryDays: bad })).status).toBe(400);
    }
    expect((await call("zeynep", "PATCH", url, { deliveryDays: null })).status).toBe(403);
    expect((await call("sahip", "GET", url)).body.deliveryDays).toEqual({ min: 7, max: 14 }); // geçersizler değiştirmedi
    expect((await patch({ deliveryDays: null })).body.deliveryDays).toBeNull();
  });

  it("bekleyen sayısı Lina'nın şu anki durumunu da söyler: açık, kapalı, mesai dışı", async () => {
    const settings = `/api/tenants/${tenantA}/settings`;
    const state = async () => (await call("zeynep", "GET", `/api/tenants/${tenantA}/waiting-count`)).body.bot;
    await call("sahip", "PATCH", settings, { botEnabled: true, botHoursOnly: false });
    expect(await state()).toBe("on");
    await call("sahip", "PATCH", settings, { botEnabled: false });
    expect(await state()).toBe("off");
    // Açık ama "yalnızca mesai saatlerinde" ve şu an (cumartesi) mesai dışı.
    await call("sahip", "PATCH", settings, { botEnabled: true, botHoursOnly: true, businessHours: { days: [1], start: "10:00", end: "18:00" } });
    expect(await state()).toBe("hours");
    await call("sahip", "PATCH", settings, { botHoursOnly: false, businessHours: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "18:00" } });
    expect(await state()).toBe("on");
  });

  it("listeler 100 işte kesilir ama sessizce değil: 'more' gelir", async () => {
    const { db } = database;
    const rows = Array.from({ length: 101 }, (_, i) => ({ tenantId: tenantA, conversationId: ids.conv!, kind: "complaint" as const, important: true, question: `q${i}`, answer: "a" }));
    await db.insert(notifications).values(rows);
    const list = await call("zeynep", "GET", `/api/tenants/${tenantA}/notifications?filter=important`);
    expect(list.body.notifications).toHaveLength(100);
    expect(list.body.more).toBe(true);
    // 100'e düşünce daha fazlası yok.
    await db.delete(notifications).where(eq(notifications.question, "q100"));
    expect((await call("zeynep", "GET", `/api/tenants/${tenantA}/notifications?filter=important`)).body.more).toBe(false);
    await db.delete(notifications).where(eq(notifications.tenantId, tenantA));

    await db.insert(teamQuestions).values(Array.from({ length: 101 }, (_, i) => ({ tenantId: tenantA, conversationId: ids.conv!, question: `soru ${i}` })));
    const questions = await call("zeynep", "GET", `/api/tenants/${tenantA}/team-questions`);
    expect(questions.body.questions).toHaveLength(100);
    expect(questions.body.more).toBe(true);
    await db.delete(teamQuestions).where(eq(teamQuestions.tenantId, tenantA));
    expect((await call("zeynep", "GET", `/api/tenants/${tenantA}/team-questions`)).body.more).toBe(false);
  });

  it("kaynak çelişkisi uyarıları: yalnızca sahip görür ve çözer; başka mağazanınki görünmez, kapanan listeden düşer", async () => {
    const { db } = database;
    const [mine] = await db.insert(knowledgeAlerts).values({ tenantId: tenantA, topic: "İade süresi", description: "Politika 14 gün, SSS 30 gün diyor." }).returning();
    const [theirs] = await db.insert(knowledgeAlerts).values({ tenantId: tenantB, topic: "Kargo", description: "Başka mağaza" }).returning();
    const url = `/api/tenants/${tenantA}/knowledge-alerts`;
    expect((await call("zeynep", "GET", url)).status).toBe(403);
    const list = await call("sahip", "GET", url);
    expect(list.body.alerts.map((a: { topic: string }) => a.topic)).toEqual(["İade süresi"]);

    expect((await call("zeynep", "POST", `${url}/${mine!.id}/resolve`)).status).toBe(403);
    expect((await call("sahip", "POST", `${url}/${theirs!.id}/resolve`)).status).toBe(404); // başka mağazanın uyarısı
    expect((await call("sahip", "POST", `${url}/degil/resolve`)).status).toBe(404);
    expect((await call("sahip", "POST", `${url}/${mine!.id}/resolve`)).body).toEqual({ ok: true });
    expect((await call("sahip", "GET", url)).body.alerts).toEqual([]);
    expect((await call("sahip", "POST", `${url}/${mine!.id}/resolve`)).status).toBe(404); // zaten çözülmüş
    const [other] = await db.select().from(knowledgeAlerts).where(eq(knowledgeAlerts.id, theirs!.id));
    expect(other!.status).toBe("open");
    await db.delete(knowledgeAlerts);
  });

  it("ekip: bekleyen davetler listelenir ve iptal edilir; çıkarılan kişinin erişimi hemen kapanır", async () => {
    const url = `/api/tenants/${tenantA}`;
    expect((await call("zeynep", "GET", `${url}/members`)).status).toBe(403); // çalışan ekibi göremez
    const invite = await call("sahip", "POST", `${url}/invites`, { email: "yeni@maius.test", role: "agent" });
    expect(invite.status).toBe(200);
    const listed = (await call("sahip", "GET", `${url}/members`)).body;
    expect(listed.members.map((m: any) => m.name).sort()).toEqual(["Ali", "Serap", "Zeynep"]);
    expect(listed.invites).toMatchObject([{ email: "yeni@maius.test", role: "agent" }]);
    const inviteId = listed.invites[0].id;
    expect((await call("zeynep", "DELETE", `${url}/invites/${inviteId}`)).status).toBe(403);
    expect((await call("sahip", "DELETE", `${url}/invites/${inviteId}`)).status).toBe(200);
    expect((await call("sahip", "GET", `${url}/members`)).body.invites).toEqual([]);
    expect((await call("sahip", "DELETE", `${url}/invites/${inviteId}`)).status).toBe(404);

    // Kendini ve son sahibi çıkaramaz; çalışanı çıkarınca o kişinin bu mağazaya erişimi hemen biter.
    expect((await call("sahip", "DELETE", `${url}/members/${ids.sahip}`)).status).toBe(409);
    expect((await call("zeynep", "GET", `${url}/conversations`)).status).toBe(200);
    expect((await call("zeynep", "DELETE", `${url}/members/${ids.ali}`)).status).toBe(403);
    expect((await call("sahip", "DELETE", `${url}/members/${ids.zeynep}`)).status).toBe(200);
    // Başka mağazası olmadığı için oturumu da silinir (401); başka mağazası olsaydı bu mağaza 404 verirdi.
    expect((await call("zeynep", "GET", `${url}/conversations`)).status).toBe(401);
    expect((await call("sahip", "DELETE", `${url}/members/${ids.zeynep}`)).status).toBe(404);
    // Başka mağazanın üyesi bu mağazadan çıkarılamaz.
    expect((await call("sahip", "DELETE", `/api/tenants/${tenantB}/members/${ids.ali}`)).status).toBe(404);
    // Test düzeni: zeynep'i geri ekle ve yeniden giriş yaptır.
    await database.db.insert(memberships).values({ userId: ids.zeynep!, tenantId: tenantA, role: "agent" });
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email: "zeynep@maius.test", password: PASSWORD }) });
    cookies.zeynep = login.headers.get("set-cookie")!.split(";")[0]!;
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

describe("panel: Lina'ya bilgi ver", () => {
  const info = (text: unknown, who = "zeynep", id: string = ids.conv!) => call(who, "POST", `/api/tenants/${tenantA}/conversations/${id}/lina-info`, { text });
  const notesA = async () => (await database.db.select({ notes: tenants.notes }).from(tenants).where(eq(tenants.id, tenantA)))[0]!.notes;

  it("çalışan da yazabilir; bilgi tarih, saat ve adıyla mağaza notlarının sonuna eklenir, eski notlar korunur", async () => {
    await database.db.update(tenants).set({ notes: "Kargo Yurtiçi ile gider." }).where(eq(tenants.id, tenantA));
    const res = await info("  Lexux Top 19 Ekim'de   kargoya çıkıyor.  ");
    expect(res.status).toBe(200);
    const notes = await notesA();
    const lines = notes.split("\n");
    expect(lines[0]).toBe("Kargo Yurtiçi ile gider.");
    // Test saatinden (İstanbul) damga: [tarih, saat · ad] bilgi
    expect(lines[1]).toMatch(/^\[\d{1,2} \p{L}+ 2026, \d{2}:\d{2} · Zeynep\] Lexux Top 19 Ekim'de kargoya çıkıyor\.$/u);
    expect(res.body.line).toBe(lines[1]);
  });

  it("Lina'nın açık sorusu varsa satıra eklenir; çok kısa ya da çok uzun bilgi, yabancı konuşma ve geçersiz kimlik reddedilir", async () => {
    await database.db.insert(teamQuestions).values({ tenantId: tenantA, conversationId: ids.conv!, question: "Lexux Top ne zaman gelir?" });
    expect((await info("Lexux 19 Ekim")).status).toBe(200);
    expect((await notesA()).split("\n").at(-1)).toContain("(Lina'nın sorusu: \"Lexux Top ne zaman gelir?\")");
    expect((await info("ab")).status).toBe(400);
    expect((await info("x".repeat(1001))).status).toBe(400);
    expect((await info(42)).status).toBe(400);
    expect((await info("Geçerli bilgi", "zeynep", ids.other!)).status).toBe(404); // başka mağazanın konuşması
    expect((await info("Geçerli bilgi", "zeynep", "yok")).status).toBe(404);
  });

  it("notlar dolduysa 422 verir ve hiçbir şey eklenmez", async () => {
    await database.db.update(tenants).set({ notes: "a".repeat(7990) }).where(eq(tenants.id, tenantA));
    expect((await info("Bu satır sığmaz, notlar zaten dolu.")).status).toBe(422);
    expect((await notesA()).length).toBe(7990);
  });
});

describe("panel: müşteri verisini silme (silme talebi)", () => {
  it("yalnızca sahip siler, onay ister; kişi, mesajlar, fotoğraf ve kayıtlar gider, maliyet kaydı kalır; başka mağaza ve müşteriler dokunulmaz", async () => {
    const { db } = database;
    const [photo] = await db.insert(messages).values({ tenantId: tenantA, conversationId: ids.conv!, sender: "customer", type: "image", text: null }).returning();
    await db.insert(media).values({ tenantId: tenantA, messageId: photo!.id, waMediaId: "m1", mimeType: "image/jpeg", sizeBytes: 3, data: Buffer.from("abc") });
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, ids.conv!));
    await db.insert(customerMemories).values({ tenantId: tenantA, customerId: conversation!.customerId, text: "Ayşe: beden 38" });
    await db.insert(notifications).values({ tenantId: tenantA, conversationId: ids.conv!, kind: "complaint", important: true, question: "Ayşe: ürün hasarlı", answer: "a" });
    await db.insert(teamQuestions).values({ tenantId: tenantA, conversationId: ids.conv!, question: "Ayşe'nin siparişi?" });
    await db.insert(agentRuns).values({ tenantId: tenantA, conversationId: ids.conv!, agent: "lina", model: "m", input: "Ayşe: siparişim nerede", output: "Merhaba Ayşe", apiCalls: 2, inputTokens: 100, outputTokens: 20 });
    const [otherConv] = await db.select().from(conversations).where(eq(conversations.id, ids.other!));

    // Çalışan silemez; onay olmadan sahip de silemez.
    expect((await call("zeynep", "POST", conv("/erase"), { confirm: true })).status).toBe(403);
    expect((await call("sahip", "POST", conv("/erase"), {})).status).toBe(400);
    expect(await thread()).not.toHaveLength(0);

    // Başka mağazanın konuşması bu mağaza adıyla silinemez.
    expect((await call("sahip", "POST", `/api/tenants/${tenantA}/conversations/${ids.other}/erase`, { confirm: true })).status).toBe(404);
    expect(await db.select().from(conversations).where(eq(conversations.id, otherConv!.id))).toHaveLength(1);

    const res = await call("sahip", "POST", conv("/erase"), { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, messages: 2, photos: 1 });
    expect(await db.select().from(conversations).where(eq(conversations.id, ids.conv!))).toHaveLength(0);
    expect(await db.select().from(customers).where(eq(customers.id, conversation!.customerId))).toHaveLength(0);
    expect(await thread()).toHaveLength(0);
    expect(await db.select().from(media).where(eq(media.tenantId, tenantA))).toHaveLength(0);
    expect(await db.select().from(handoffs).where(eq(handoffs.tenantId, tenantA))).toHaveLength(0);
    expect(await db.select().from(notifications).where(eq(notifications.tenantId, tenantA))).toHaveLength(0);
    expect(await db.select().from(teamQuestions).where(eq(teamQuestions.tenantId, tenantA))).toHaveLength(0);
    expect(await db.select().from(customerMemories).where(eq(customerMemories.tenantId, tenantA))).toHaveLength(0);
    // Maliyet istatistiği kalır; müşterinin yazdıkları ve konuşma bağı gider.
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenantA));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ conversationId: null, input: null, output: null, apiCalls: 2, inputTokens: 100, outputTokens: 20 });
    // Aynı müşteri bir daha silinemez; ekran yenilensin diye canlı sinyal gitti.
    expect((await call("sahip", "POST", conv("/erase"), { confirm: true })).status).toBe(404);
    expect(events.some((e) => e.type === "conversation" && (e as { conversationId?: string }).conversationId === ids.conv)).toBe(true);
  });
});
