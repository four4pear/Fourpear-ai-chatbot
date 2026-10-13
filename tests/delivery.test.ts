import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linaSystemPrompt } from "../src/agents/prompts.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { tenants, type Tenant } from "../src/db/schema.js";
import { loadKnowledge } from "../src/knowledge/base.js";
import { buildOrderSheet } from "../src/orders/facts.js";
import type { OrderFacts, OrderItem } from "../src/orders/types.js";

const TZ = "Europe/Istanbul";
const NOW = new Date("2026-09-28T09:00:00Z"); // 28 Eylül 2026 12:00 İstanbul
const RULE = { min: 7, max: 14 };

const item = (over: Partial<OrderItem> = {}): OrderItem => ({
  id: "li1", productId: null, title: "Mira Gömlek", variantTitle: null, options: [], productOptionValues: [], quantity: 1, unfulfilled: 1, currentDescription: null, ...over,
});
const order = (createdAt: string, over: Partial<OrderFacts> = {}): OrderFacts => ({
  name: "#MO-1", createdAt: new Date(`${createdAt}T10:00:00+03:00`), cancelledAt: null, phones: ["905321234567"], names: [], items: [item()], shipments: [], ...over,
});
const sheet = (o: OrderFacts, rule: typeof RULE | null = RULE) => buildOrderSheet(o, new Map(), NOW, TZ, "whatsapp", rule);

describe("katı teslimat kuralı: sipariş kartı", () => {
  it("süre içindeki siparişte kural, kaç gün önce verildiği ve en geç teslim tarihi yazılır; ekibe bildirim yok", () => {
    const s = sheet(order("2026-09-20")); // 8 gün önce
    expect(s.text).toContain("TESLİMAT KURALI (mağazanın kesin kuralı): siparişlerin hepsi sipariş tarihinden itibaren 7-14 gün içinde teslim edilir");
    expect(s.text).toContain("Sipariş 8 gün önce verildi; teslimat süresinin içinde. En geç 4 Ekim 2026 tarihine kadar");
    expect(s.issues).toEqual([]);
  });

  it("henüz erkense 'geç kaldı' denmez", () => {
    const s = sheet(order("2026-09-25")); // 3 gün önce
    expect(s.text).toContain("Sipariş 3 gün önce verildi; henüz erken");
    expect(s.text).toContain("En geç 9 Ekim 2026");
    expect(s.issues).toEqual([]);
    expect(sheet(order("2026-09-28")).text).toContain("Sipariş bugün verildi; henüz erken");
  });

  it("süre aşıldıysa ve teslim edilmediyse: özür, yeni tarih yok ve ekibe gecikme bildirimi", () => {
    const s = sheet(order("2026-09-10")); // 18 gün önce
    expect(s.text).toContain("Sipariş 18 gün önce verildi: SÜRE AŞILDI (kural en fazla 14 gün)");
    expect(s.text).toContain("yeni bir tarih söyleme; konu ekibe bildirildi");
    expect(s.issues).toEqual([{ kind: "delay", orderName: "#MO-1", text: "Gecikme: sipariş 18 gündür teslim edilmedi (mağaza kuralı en fazla 14 gün)" }]);
    // Kargoya verilmiş ama teslim edilmemişse de aşım sayılır.
    const shipped = order("2026-09-10", { items: [item({ unfulfilled: 0 })], shipments: [{ createdAt: new Date("2026-09-12T10:00:00Z"), status: "IN_TRANSIT", deliveredAt: null, carrier: "Yurtiçi", trackingNumber: "1", trackingUrl: null, itemIds: ["li1"], requiresShipping: true }] });
    expect(sheet(shipped).issues).toHaveLength(1);
  });

  it("teslim edilmiş, iptal edilmiş ya da kural yoksa kural satırı da bildirim de yok", () => {
    const delivered = order("2026-09-10", { items: [item({ unfulfilled: 0 })], shipments: [{ createdAt: new Date("2026-09-12T10:00:00Z"), status: "DELIVERED", deliveredAt: new Date("2026-09-20T10:00:00Z"), carrier: null, trackingNumber: "1", trackingUrl: null, itemIds: ["li1"], requiresShipping: true }] });
    for (const s of [sheet(delivered), sheet(order("2026-09-10", { cancelledAt: new Date("2026-09-11T10:00:00Z") })), sheet(order("2026-09-10"), null)]) {
      expect(s.text).not.toContain("TESLİMAT KURALI");
      expect(s.issues).toEqual([]);
    }
  });

  it("ön siparişte ürün sayfasındaki kargo tarihi henüz gelmediyse süre aşıldı denmez, bildirim açılmaz", () => {
    const preorder = item({ productId: "p1", currentDescription: "🕒 ÖN SİPARİŞ: Bu ürün siparişleri 5 Ekim tarihinde kargoya teslim edilir." });
    const s = sheet(order("2026-09-10", { items: [preorder] })); // 18 gün önce ama kargo tarihi 5 Ekim
    expect(s.text).toContain("ön sipariş ve ürün sayfasındaki kargo tarihi henüz gelmedi");
    expect(s.text).not.toContain("SÜRE AŞILDI");
    expect(s.issues.filter((i) => i.text.includes("teslim edilmedi"))).toEqual([]);
  });
});

describe("katı teslimat kuralı: bilgi ve Lina", () => {
  let database: Database;
  let tenant: Tenant;
  beforeAll(async () => {
    database = await openDatabase({});
    [tenant] = (await database.db.insert(tenants).values({ slug: "maius", name: "MAIUS", notes: "Pazar kapalı." }).returning()) as [Tenant];
  });
  afterAll(() => database.close());

  it("kural varsa mağaza notlarına 'kesin kural' satırı eklenir; yoksa notlar olduğu gibi", async () => {
    expect((await loadKnowledge(database.db, tenant))!.notes).toBe("Pazar kapalı.");
    await database.db.update(tenants).set({ settings: { deliveryDays: RULE } }).where(eq(tenants.id, tenant.id));
    const [row] = await database.db.select().from(tenants).where(eq(tenants.id, tenant.id));
    const notes = (await loadKnowledge(database.db, row!))!.notes;
    expect(notes).toBe("Pazar kapalı.\n\nTeslimat süresi (mağazanın kesin kuralı; politika ve sayfalardan önce gelir): siparişlerin hepsi sipariş tarihinden itibaren 7-14 gün içinde teslim edilir.");
    // Not yoksa da kural tek başına bilgi tabanı olur.
    const [bare] = await database.db.update(tenants).set({ notes: "" }).where(eq(tenants.id, tenant.id)).returning();
    expect((await loadKnowledge(database.db, bare!))!.notes).toContain("7-14 gün içinde teslim edilir");
  });

  it("Lina'nın talimatı kuralı KATI KURAL olarak söyler; kural yoksa satır yoktur", () => {
    const withRule = linaSystemPrompt(tenant, [], { orders: true, delivery: RULE });
    expect(withRule).toContain("Teslimat süresi KATI KURALDIR: siparişlerin hepsi sipariş tarihinden itibaren 7-14 gün içinde teslim edilir");
    expect(withRule).toContain("Müşteriye başka bir süre söyleme");
    expect(linaSystemPrompt(tenant, [], { orders: true })).not.toContain("KATI KURAL");
    expect(linaSystemPrompt(tenant, [], { orders: true, delivery: null })).not.toContain("KATI KURAL");
  });
});
