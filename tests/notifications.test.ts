import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { newFindings } from "../src/agents/order-lookup.js";
import { EventBus, type PanelEvent } from "../src/core/events.js";
import { recordOrderNotification } from "../src/core/notifications.js";
import type { Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { conversations, customers, memberships, notifications, tenants, users, whatsappAccounts } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";

const ORIGIN = "http://panel.test";
const PASSWORD = "dogru-sifre-123";

let database: Database;
let server: Server;
let base: string;
let tenantA: string;
let tenantB: string;
let cookie: string;
const events: PanelEvent[] = [];
const ids: Record<string, string> = {};

async function call(method: string, path: string) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: ORIGIN, cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  database = await openDatabase({});
  const { db } = database;
  const bus = new EventBus();
  const [a, b] = await db
    .insert(tenants)
    .values([
      { slug: "maius", name: "MAIUS" },
      { slug: "diger", name: "Diğer" },
    ])
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;
  bus.subscribe(tenantA, (e) => events.push(e));

  const [user] = await db
    .insert(users)
    .values({ email: "calisan@maius.test", name: "Zeynep", passwordHash: await hashPassword(PASSWORD) })
    .returning();
  await db.insert(memberships).values({ userId: user!.id, tenantId: tenantA, role: "agent" });

  // Her mağazada bir müşteri ve konuşma.
  for (const [tenantId, key] of [[tenantA, "a"], [tenantB, "b"]] as const) {
    const [acc] = await db.insert(whatsappAccounts).values({ tenantId, phoneNumberId: `pn-${key}`, accessTokenEnc: "x" }).returning();
    const [cust] = await db.insert(customers).values({ tenantId, waId: "905321234567", name: key === "a" ? "Ayşe" : "Fatma" }).returning();
    const [conv] = await db.insert(conversations).values({ tenantId, customerId: cust!.id, whatsappAccountId: acc!.id }).returning();
    ids[`conv-${key}`] = conv!.id;
  }
  const rows = await db
    .insert(notifications)
    .values([
      {
        tenantId: tenantA,
        conversationId: ids["conv-a"]!,
        kind: "delay",
        important: true,
        orderNames: ["#MO-9001"],
        question: "Siparişim nerede?",
        answer: "Planlanan kargo tarihi 25 Eylül'dü, kısa bir gecikme var. Ekibimize ilettim.",
        details: { kinds: ["delay", "order_question"], issues: ["Gecikme: Lavin Etek (Siyah), planlanan kargo 25 Eylül 2026"] },
      },
      {
        tenantId: tenantA,
        conversationId: ids["conv-a"]!,
        kind: "order_question",
        important: false,
        orderNames: ["#MO-9002"],
        question: "Kargom nerede?",
        answer: "Siparişiniz kargoda.",
      },
      {
        tenantId: tenantB,
        conversationId: ids["conv-b"]!,
        kind: "complaint",
        important: true,
        question: "Ürün yırtık",
        answer: "Özür dileriz.",
      },
    ])
    .returning();
  ids.delay = rows[0]!.id;
  ids.question = rows[1]!.id;
  ids.otherTenant = rows[2]!.id;

  const deps = { db, log: { info() {}, warn() {}, error() {} } } as unknown as Deps;
  const { app } = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }, deps, undefined, {
    db,
    publicUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
    secureCookies: false,
    wa: { sendText: async () => [], markReadAndTyping: async () => {}, downloadMedia: async () => ({ data: Buffer.alloc(0), mimeType: "image/jpeg" }) },
    masterKey: Buffer.alloc(32).toString("base64"),
    events: bus,
    log: { info() {}, warn() {}, error() {} },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: "calisan@maius.test", password: PASSWORD }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  server.close();
  await database.close();
});

describe("panel: ekibe bildirimler", () => {
  it("mağazanın açık bildirimleri, sayılar ve Türkçe adlarla listelenir", async () => {
    const { status, body } = await call("GET", `/api/tenants/${tenantA}/notifications`);
    expect(status).toBe(200);
    expect(body.counts).toEqual({ open: 2, important: 1 });
    expect(body.notifications.map((n: any) => n.id).sort()).toEqual([ids.delay, ids.question].sort());
    const delay = body.notifications.find((n: any) => n.id === ids.delay);
    expect(delay).toMatchObject({
      label: "Gecikme",
      important: true,
      orderNames: ["#MO-9001"],
      issues: ["Gecikme: Lavin Etek (Siyah), planlanan kargo 25 Eylül 2026"],
      kinds: [
        { kind: "delay", label: "Gecikme" },
        { kind: "order_question", label: "Sipariş sorusu" },
      ],
      customer: { name: "Ayşe", phone: "+90 532 123 45 67" },
    });
  });

  it("yalnızca önemliler süzülebilir", async () => {
    const { body } = await call("GET", `/api/tenants/${tenantA}/notifications?filter=important`);
    expect(body.notifications.map((n: any) => n.id)).toEqual([ids.delay]);
  });

  it("başka mağazanın bildirimi görülemez ve kapatılamaz", async () => {
    expect((await call("GET", `/api/tenants/${tenantB}/notifications`)).status).toBe(404);
    expect((await call("POST", `/api/tenants/${tenantA}/notifications/${ids.otherTenant}/done`)).status).toBe(404);
    expect((await call("POST", `/api/tenants/${tenantA}/notifications/bozuk-kimlik/done`)).status).toBe(404);
  });

  it("tamamlandı işaretlenir, kimin kapattığı görünür, açık panellere haber gider", async () => {
    expect((await call("POST", `/api/tenants/${tenantA}/notifications/${ids.delay}/done`)).status).toBe(200);
    expect(events).toContainEqual({ type: "notification_update", conversationId: ids["conv-a"] });

    const open = await call("GET", `/api/tenants/${tenantA}/notifications`);
    expect(open.body.counts).toEqual({ open: 1, important: 0 });
    const done = await call("GET", `/api/tenants/${tenantA}/notifications?status=done`);
    expect(done.body.notifications).toEqual([expect.objectContaining({ id: ids.delay, status: "done", doneBy: { name: "Zeynep" } })]);

    // İkinci kez işaretlemek kimin ve ne zaman kapattığını değiştirmez.
    const [before] = await database.db.select().from(notifications).where(eq(notifications.id, ids.delay!));
    expect((await call("POST", `/api/tenants/${tenantA}/notifications/${ids.delay}/done`)).status).toBe(200);
    const [after] = await database.db.select().from(notifications).where(eq(notifications.id, ids.delay!));
    expect(after!.doneAt).toEqual(before!.doneAt);
  });

  it("aynı vaka ekibe bir kez düşer: açık bildirim güncellenir; ekip tamamladıysa yenisi açılır", async () => {
    const { db } = database;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, ids["conv-a"]!));
    // Müşteri başına tek konuşma vardır: ayrı bir müşteriyle yeni konuşma.
    const [customer] = await db.insert(customers).values({ tenantId: tenantA, waId: "905329998877", name: "Elif" }).returning();
    const [fresh] = await db
      .insert(conversations)
      .values({ tenantId: tenantA, customerId: customer!.id, whatsappAccountId: conv!.whatsappAccountId })
      .returning();
    const bus = new EventBus();
    const seen: PanelEvent[] = [];
    bus.subscribe(tenantA, (e) => seen.push(e));
    const complaint = (issue: string) => {
      const findings = newFindings();
      findings.topics.push("complaint");
      findings.orders.set("#MO-9010", { unshipped: false, cancelled: false });
      findings.issues.push({ kind: "return_review", text: issue });
      return findings;
    };
    const record = (question: string, answer: string, issue: string) =>
      recordOrderNotification({ db, events: bus }, { tenantId: tenantA, conversationId: fresh!.id, findings: complaint(issue), question, answer, replySent: true });
    const mine = () => db.select().from(notifications).where(eq(notifications.conversationId, fresh!.id));

    await record("Ürün hasarlı geldi", "Çok üzgünüm, hemen ilgileniyorum.", "Hasarlı ürün: fotoğraf bekleniyor");
    await record("Fotoğrafı gönderdim, ne olacak?", "İade birimine ilettim.", "Hasarlı ürün: fotoğraf geldi");
    const [merged, ...others] = await mine();
    expect(others).toEqual([]);
    expect(merged).toMatchObject({
      kind: "complaint",
      important: true,
      status: "open",
      orderNames: ["#MO-9010"],
      question: "Ürün hasarlı geldi\nFotoğrafı gönderdim, ne olacak?",
      answer: "İade birimine ilettim.",
      details: { kinds: ["complaint", "return_review"], issues: ["Hasarlı ürün: fotoğraf bekleniyor", "Hasarlı ürün: fotoğraf geldi"] },
    });
    // İlki yeni bildirimdir (sesli uyarı); ikincisi yalnızca listeyi yeniler.
    expect(seen).toEqual([
      { type: "notification", conversationId: fresh!.id, important: true },
      { type: "notification_update", conversationId: fresh!.id },
    ]);

    await db.update(notifications).set({ status: "done" }).where(eq(notifications.id, merged!.id));
    await record("Hâlâ dönüş olmadı", "Tekrar ilettim.", "Hasarlı ürün: müşteri tekrar yazdı");
    expect((await mine()).map((n) => n.status).sort()).toEqual(["done", "open"]);
    await db.delete(notifications).where(eq(notifications.conversationId, fresh!.id));
  });

  it("konuşma ayrıntısında o konuşmanın bildirimleri de gelir", async () => {
    const { body } = await call("GET", `/api/tenants/${tenantA}/conversations/${ids["conv-a"]}`);
    expect(body.notifications.map((n: any) => n.label).sort()).toEqual(["Gecikme", "Sipariş sorusu"]);
  });
});
