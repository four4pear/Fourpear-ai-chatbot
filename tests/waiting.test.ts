import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { EventBus, type PanelEvent } from "../src/core/events.js";
import { escalateWaitingCustomers } from "../src/core/waiting.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { conversations, customers, handoffs, messages, notifications, tenants, whatsappAccounts, type Tenant } from "../src/db/schema.js";

const TZ = "Europe/Istanbul";
// Perşembe 8 Ekim 2026 12:00 İstanbul (mesai içi: hafta içi 09:00-18:00) ve aynı gün 22:00 (mesai dışı).
const OPEN = new Date("2026-10-08T09:00:00Z");
const CLOSED = new Date("2026-10-08T19:00:00Z");
const ago = (minutes: number, from = OPEN) => new Date(from.getTime() - minutes * 60_000);

let database: Database;
let tenant: Tenant;
let accountId: string;
let seq = 0;
const events: PanelEvent[] = [];
const bus = new EventBus();

beforeAll(async () => {
  database = await openDatabase({});
  [tenant] = (await database.db.insert(tenants).values({ slug: "maius", name: "MAIUS" }).returning()) as [Tenant];
  const [acc] = await database.db.insert(whatsappAccounts).values({ tenantId: tenant.id, phoneNumberId: "pn", accessTokenEnc: "x" }).returning();
  accountId = acc!.id;
  bus.subscribe(tenant.id, (e) => events.push(e));
});
afterAll(() => database.close());
beforeEach(async () => {
  await database.db.delete(customers).where(eq(customers.tenantId, tenant.id));
  events.length = 0;
});

/** Konuşma kurar: durum, mesajlar ([gönderen, kaç dakika önce]) ve istenirse açık devir. */
async function conversation(status: "bot" | "waiting" | "human", sent: ["customer" | "agent" | "bot", number][], handoffMinutesAgo?: number) {
  const [c] = await database.db.insert(customers).values({ tenantId: tenant.id, waId: `90532000${String(++seq).padStart(4, "0")}`, name: "Ayşe" }).returning();
  const lastCustomer = sent.filter(([who]) => who === "customer").map(([, m]) => ago(m)).sort((a, b) => b.getTime() - a.getTime())[0];
  const [conv] = await database.db
    .insert(conversations)
    .values({ tenantId: tenant.id, customerId: c!.id, whatsappAccountId: accountId, status, lastCustomerMessageAt: lastCustomer })
    .returning();
  for (const [sender, minutes] of sent) {
    await database.db.insert(messages).values({ tenantId: tenant.id, conversationId: conv!.id, sender, text: `${sender} mesajı`, createdAt: ago(minutes) });
  }
  if (handoffMinutesAgo !== undefined) {
    await database.db.insert(handoffs).values({ tenantId: tenant.id, conversationId: conv!.id, reason: "customer_request", summary: "Temsilci istiyor", createdAt: ago(handoffMinutesAgo) });
  }
  return conv!.id;
}
const run = (now: Date) => escalateWaitingCustomers({ db: database.db, events: bus }, tenant, TZ, now);
const notified = () => database.db.select().from(notifications).where(eq(notifications.tenantId, tenant.id));

describe("ekibin dönüşünü bekleyen müşteri", () => {
  it("ekipte olup son mesajı müşteriden olan konuşma 20 dakikayı geçince önemli bildirim düşer (bir kez)", async () => {
    const id = await conversation("human", [["customer", 40], ["agent", 30], ["customer", 25]]);
    expect(await run(OPEN)).toBe(1);
    const [n] = await notified();
    expect(n).toMatchObject({ kind: "customer_waiting", important: true, status: "open", conversationId: id, question: "customer mesajı" });
    expect(n!.details.issues![0]).toContain("25 dakikadır");
    expect(n!.details.issues![0]).toContain("ekipte");
    expect(events.some((e) => e.type === "notification" && e.important)).toBe(true);
    // Aynı bekleyiş için ikinci hatırlatma düşmez.
    expect(await run(new Date(OPEN.getTime() + 10 * 60_000))).toBe(0);
    expect(await notified()).toHaveLength(1);
  });

  it("erken (20 dk dolmadı), cevaplanmış, Lina'daki ve çok eski konuşmalar için düşmez", async () => {
    await conversation("human", [["customer", 10]]); // erken
    await conversation("human", [["customer", 40], ["agent", 30]]); // ekip cevapladı
    await conversation("bot", [["customer", 60], ["bot", 59]]); // Lina cevaplıyor
    await conversation("human", [["customer", 3 * 24 * 60]]); // 3 günlük eski kayıt
    expect(await run(OPEN)).toBe(0);
    expect(await notified()).toHaveLength(0);
  });

  it("kimsenin devralmadığı açık devir 20 dakikayı geçince hatırlatılır", async () => {
    const id = await conversation("waiting", [["customer", 35], ["bot", 34]], 33);
    expect(await run(OPEN)).toBe(1);
    const [n] = await notified();
    expect(n).toMatchObject({ kind: "customer_waiting", conversationId: id });
    expect(n!.details.issues![0]).toContain("devri kimse devralmadı");
  });

  it("mesai dışında bekler; mesai açılınca hatırlatır", async () => {
    await conversation("human", [["customer", 25]]);
    expect(await run(CLOSED)).toBe(0);
    expect(await notified()).toHaveLength(0);
    expect(await run(new Date(OPEN.getTime() + 24 * 60 * 60_000))).toBe(1); // ertesi gün (cuma) 12:00, hâlâ 48 saatten yeni
  });

  it("ekip cevap verince hatırlatma kendiliğinden kapanır; müşteri yeniden yazıp yine beklerse yenisi düşer", async () => {
    const id = await conversation("human", [["customer", 25]]);
    expect(await run(OPEN)).toBe(1);

    // Ekip cevapladı: son mesaj artık ekipten.
    await database.db.insert(messages).values({ tenantId: tenant.id, conversationId: id, sender: "agent", text: "Merhaba", createdAt: ago(-2) });
    await run(new Date(OPEN.getTime() + 5 * 60_000));
    expect((await notified())[0]).toMatchObject({ status: "done" });
    expect(events.some((e) => e.type === "notification_update")).toBe(true);

    // Müşteri tekrar yazdı ve yine 20 dakika geçti: yeni bekleyiş, yeni hatırlatma.
    const again = new Date(OPEN.getTime() + 10 * 60_000);
    await database.db.insert(messages).values({ tenantId: tenant.id, conversationId: id, sender: "customer", text: "Hâlâ bekliyorum", createdAt: again });
    await database.db.update(conversations).set({ lastCustomerMessageAt: again }).where(eq(conversations.id, id));
    expect(await run(new Date(again.getTime() + 21 * 60_000))).toBe(1);
    expect(await notified()).toHaveLength(2);
  });

  it("ekip hatırlatmayı kendisi tamamladıysa aynı bekleyiş için yenisi düşmez", async () => {
    await conversation("human", [["customer", 25]]);
    expect(await run(OPEN)).toBe(1);
    await database.db.update(notifications).set({ status: "done", doneAt: OPEN });
    expect(await run(new Date(OPEN.getTime() + 30 * 60_000))).toBe(0);
    expect(await notified()).toHaveLength(1);
  });
});
