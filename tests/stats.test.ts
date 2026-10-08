import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { EventBus } from "../src/core/events.js";
import type { Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { conversations, customers, handoffs, memberships, messages, notifications, teamQuestions, tenants, users, whatsappAccounts } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { computeStats } from "../src/panel/stats.js";

const ORIGIN = "http://panel.test";
const PASSWORD = "dogru-sifre-123";
const TZ = "Europe/Istanbul";
// Perşembe 8 Ekim 2026, Türkiye saatiyle 15:00 (varsayılan mesai: hafta içi 09:00-18:00).
const NOW = new Date("2026-10-08T12:00:00Z");

let database: Database;
let tenantId: string;
let otherId: string;
let server: Server;
let ownerCookie: string;
let agentCookie: string;

async function seedConversation(tenant: string, n: number) {
  const [account] = await database.db.select().from(whatsappAccounts).where(eq(whatsappAccounts.tenantId, tenant));
  const [customer] = await database.db.insert(customers).values({ tenantId: tenant, waId: `9053200000${n}` }).returning();
  const [conv] = await database.db.insert(conversations).values({ tenantId: tenant, customerId: customer!.id, whatsappAccountId: account!.id }).returning();
  return conv!.id;
}
const say = (conversationId: string, tenant: string, sender: "customer" | "bot" | "agent", at: string, text = "x") =>
  database.db.insert(messages).values({ tenantId: tenant, conversationId, sender, text, createdAt: new Date(at) });


beforeAll(async () => {
  database = await openDatabase({});
  const [a, b] = await database.db.insert(tenants).values([{ slug: "betulsaday", name: "Betül Saday" }, { slug: "diger", name: "Diğer" }]).returning();
  tenantId = a!.id;
  otherId = b!.id;
  for (const t of [tenantId, otherId]) {
    await database.db.insert(whatsappAccounts).values({ tenantId: t, phoneNumberId: `pn-${t}`, accessTokenEnc: "x" });
  }

  // 1) Lina tek başına çözdü: mesai içinde yazdı, sessiz kayıt ekip işi sayılmaz.
  const c1 = await seedConversation(tenantId, 1);
  await say(c1, tenantId, "customer", "2026-10-08T08:00:00Z");
  await say(c1, tenantId, "bot", "2026-10-08T08:00:30Z");
  await database.db.insert(notifications).values({ tenantId, conversationId: c1, kind: "order_question", important: false, question: "q", answer: "a", createdAt: new Date("2026-10-08T08:00:40Z") });

  // 2) Şikayet devri; ekip 20 dakikada yazdı.
  const c2 = await seedConversation(tenantId, 2);
  await say(c2, tenantId, "customer", "2026-10-08T07:00:00Z");
  await database.db.insert(handoffs).values({ tenantId, conversationId: c2, reason: "complaint", summary: "s", createdAt: new Date("2026-10-08T07:05:00Z") });
  await say(c2, tenantId, "agent", "2026-10-08T07:25:00Z");

  // 3) Mesai dışı (perşembe 23:00): önemli bildirim.
  const c3 = await seedConversation(tenantId, 3);
  await say(c3, tenantId, "customer", "2026-10-07T20:00:00Z");
  await database.db.insert(notifications).values({ tenantId, conversationId: c3, kind: "return_review", important: true, question: "q", answer: "a", createdAt: new Date("2026-10-07T20:05:00Z") });

  // 4) Cumartesi (kapalı gün): Lina ekibe soru sordu.
  const c4 = await seedConversation(tenantId, 4);
  await say(c4, tenantId, "customer", "2026-10-03T10:00:00Z");
  await database.db.insert(teamQuestions).values({ tenantId, conversationId: c4, question: "soru", createdAt: new Date("2026-10-03T10:10:00Z") });

  // 5) Pencere dışı; 6) başka mağaza: hiçbiri sayılmaz.
  const c5 = await seedConversation(tenantId, 5);
  await say(c5, tenantId, "customer", "2026-09-20T10:00:00Z");
  const c6 = await seedConversation(otherId, 6);
  await say(c6, otherId, "customer", "2026-10-08T08:00:00Z");
  await database.db.insert(handoffs).values({ tenantId: otherId, conversationId: c6, reason: "other", summary: "s", createdAt: new Date("2026-10-08T08:05:00Z") });

  const deps = { db: database.db, model: "m", timeZone: TZ, log: { info() {}, warn() {}, error() {} } } as unknown as Deps;
  const { app } = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }, deps, undefined, {
    db: database.db, publicUrl: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: false,
    wa: { sendText: async () => [], markReadAndTyping: async () => {}, downloadMedia: async () => ({ data: Buffer.alloc(0), mimeType: "image/jpeg" }) },
    masterKey: Buffer.alloc(32).toString("base64"), events: new EventBus(), log: { info() {}, warn() {}, error() {} }, now: () => NOW,
  });
  server = app.listen(0);
  const login = async (email: string, role: "owner" | "agent") => {
    const [user] = await database.db.insert(users).values({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD) }).returning();
    await database.db.insert(memberships).values({ userId: user!.id, tenantId, role });
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, password: PASSWORD }),
    });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  ownerCookie = await login("sahip@stats.test", "owner");
  agentCookie = await login("calisan@stats.test", "agent");
});
afterAll(async () => {
  server.close();
  await database.close();
});

describe("konuşma istatistikleri", () => {
  it("7 gün: konuşma, Lina'nın çözdüğü, ekibe giden, dönüş süresi, mesai dışı", async () => {
    const s = await computeStats(database.db, tenantId, 7, TZ, NOW);
    expect(s.conversations).toBe(4);
    expect(s.team).toBe(3);
    expect(s.solvedByLina).toBe(1);
    expect(s.avgResponseMinutes).toBe(20);
    expect(s.afterHours).toBe(2);
  });

  it("ekibe giden işlerin sebepleri: devir, önemli bildirim ve Lina'nın sorusu; sessiz kayıt sayılmaz", async () => {
    const s = await computeStats(database.db, tenantId, 7, TZ, NOW);
    expect(s.reasons).toEqual([
      { label: "İade: ekip kararı gerekiyor", count: 1 },
      { label: "Lina ekibe soru sordu", count: 1 },
      { label: "Şikayet", count: 1 },
    ]);
  });

  it("günlük dağılım: boş günler de var, ekip girdiyse 'ekip', girmediyse 'Lina'", async () => {
    const s = await computeStats(database.db, tenantId, 7, TZ, NOW);
    expect(s.bucketSize).toBe("day");
    expect(s.buckets.map((b) => b.key)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    const by = Object.fromEntries(s.buckets.map((b) => [b.key, b]));
    expect(by["2026-10-08"]).toMatchObject({ solved: 1, team: 1 });
    expect(by["2026-10-07"]).toMatchObject({ solved: 0, team: 1 });
    expect(by["2026-10-03"]).toMatchObject({ solved: 0, team: 1 });
    expect(by["2026-10-05"]).toMatchObject({ solved: 0, team: 0 });
    // Her konuşma yalnızca bir kovada toplanır: toplamlar konuşma sayısını verir.
    expect(s.buckets.reduce((n, b) => n + b.solved + b.team, 0)).toBe(s.conversations);
  });

  it("24 saat: saatlik kova, pencere dışındaki konuşmalar yok", async () => {
    const s = await computeStats(database.db, tenantId, 1, TZ, NOW);
    expect(s.bucketSize).toBe("hour");
    expect(s.conversations).toBe(3);
    expect(s.buckets.length).toBeGreaterThanOrEqual(24);
    expect(s.buckets[0]!.key).toMatch(/^2026-10-07T\d\d$/);
    expect(s.buckets.reduce((n, b) => n + b.solved + b.team, 0)).toBe(3);
  });

  it("veri yoksa sıfırlar ve dönüş süresi boş", async () => {
    const s = await computeStats(database.db, otherId, 30, TZ, new Date("2026-12-01T12:00:00Z"));
    expect(s).toMatchObject({ conversations: 0, solvedByLina: 0, team: 0, avgResponseMinutes: null, afterHours: 0, reasons: [] });
  });

  it("API: yalnızca mağaza sahibi; geçersiz dönem 7 güne düşer", async () => {
    const get = (cookie: string, q: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${tenantId}/stats${q}`, { headers: { cookie, origin: ORIGIN } });
    expect((await get(agentCookie, "?days=7")).status).toBe(403);
    expect((await get("", "?days=7")).status).toBe(401);
    const ok = await get(ownerCookie, "?days=7");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ days: 7, conversations: 4, team: 3 });
    expect(((await (await get(ownerCookie, "?days=99")).json()) as { days: number }).days).toBe(7);
  });
});
