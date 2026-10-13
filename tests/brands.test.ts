import { randomBytes, randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Llm } from "../src/agents/runner.js";
import { brandLabel, compositeOrderSource, compositeProductSource, loadBrands, mergeKnowledge } from "../src/core/brands.js";
import { respond, type Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { conversations, customers, knowledgeDocs, messages, tenants, whatsappAccounts, type KnowledgeDoc, type Tenant } from "../src/db/schema.js";
import type { KnowledgeBase } from "../src/knowledge/base.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { buildOrderSheet, orderSummaryLine } from "../src/orders/facts.js";
import type { OrderFacts, OrderSource } from "../src/orders/types.js";
import { describeProducts } from "../src/products/types.js";
import type { ProductFacts, ProductSource } from "../src/products/types.js";

const WA = "905321234567";
const tenantOf = (name: string, domain: string | null, notes = ""): Tenant => ({ id: randomUUID(), name, domain, notes, settings: {} }) as unknown as Tenant;
const doc = (title: string, content = "içerik"): KnowledgeDoc => ({ id: randomUUID(), title, content, kind: "core", source: "policy", externalId: title }) as unknown as KnowledgeDoc;
const order = (name: string, phones: string[] = [WA], day = 10): OrderFacts => ({ name, createdAt: new Date(`2026-09-${String(day).padStart(2, "0")}T10:00:00Z`), cancelledAt: null, phones, names: [], items: [], shipments: [] });
const source = (o: { byName?: Record<string, OrderFacts>; phone?: OrderFacts[]; fail?: boolean }): OrderSource => ({
  async byName(name) {
    if (o.fail) throw new Error("Shopify hatası");
    return o.byName?.[name] ?? null;
  },
  async byPhone() {
    if (o.fail) throw new Error("Shopify hatası");
    return o.phone ?? [];
  },
});

describe("marka adı ve bilgi birleştirme", () => {
  const maius = tenantOf("MAIUS", "maiusonline.com");
  const betul = tenantOf("Betül Saday", "betulsaday.com");

  it("ad ve alan adı birlikte yazılır", () => {
    expect(brandLabel(maius)).toBe("MAIUS (maiusonline.com)");
    expect(brandLabel(tenantOf("Dükkan", null))).toBe("Dükkan");
  });

  it("tek markada bilgi olduğu gibi kalır", () => {
    const kb: KnowledgeBase = { notes: "not", core: [doc("Kargo")], legal: [] };
    expect(mergeKnowledge([{ tenant: betul, kb }])).toBe(kb);
    expect(mergeKnowledge([{ tenant: betul, kb: null }])).toBeNull();
  });

  it("birden çok markada başlıklar markayı taşır; ana mağaza notu hat geneli, bağlı mağazanın notu markaya özel", () => {
    const a: KnowledgeBase = { notes: "Bu hafta kargoda gecikme var.", core: [doc("Kargo politikası")], legal: [doc("KVKK")] };
    const b: KnowledgeBase = { notes: "Pazar kapalı.", core: [doc("Kargo politikası"), doc("İade")], legal: [] };
    const merged = mergeKnowledge([{ tenant: betul, kb: a }, { tenant: maius, kb: b }])!;
    expect(merged.core.map((d) => d.title)).toEqual(["[Betül Saday] Kargo politikası", "[MAIUS] Kargo politikası", "[MAIUS] İade"]);
    expect(merged.legal.map((d) => d.title)).toEqual(["[Betül Saday] KVKK"]);
    expect(merged.notes).toBe("Hat geneli (bütün markalar için): Bu hafta kargoda gecikme var.\n\n[MAIUS] Pazar kapalı.");
    // Özgün belge kimlikleri değişmez (hukuki metin kimlikle okunur).
    expect(merged.legal[0]!.id).toBe(a.legal[0]!.id);
  });

  it("bir markanın bilgisi yoksa diğerininki yine gelir; ikisi de boşsa null", () => {
    const b: KnowledgeBase = { notes: "", core: [doc("İade")], legal: [] };
    expect(mergeKnowledge([{ tenant: betul, kb: null }, { tenant: maius, kb: b }])!.core.map((d) => d.title)).toEqual(["[MAIUS] İade"]);
    expect(mergeKnowledge([{ tenant: betul, kb: null }, { tenant: maius, kb: null }])).toBeNull();
  });
});

describe("birleşik sipariş kaynağı", () => {
  it("numara her markada aranır, bulunan siparişe marka yazılır", async () => {
    const src = compositeOrderSource(
      [{ brand: "Betül Saday", source: source({ byName: { "#1001": order("#1001") } }) }, { brand: "MAIUS", source: source({ byName: { "MO-1271": order("#MO-1271") } }) }],
      WA,
    );
    expect(await src.byName("MO-1271")).toMatchObject({ name: "#MO-1271", brand: "MAIUS" });
    expect(await src.byName("#1001")).toMatchObject({ name: "#1001", brand: "Betül Saday" });
    expect(await src.byName("9999")).toBeNull();
  });

  it("aynı numara iki markada varsa müşterinin telefonuna ait olan seçilir", async () => {
    const src = compositeOrderSource(
      [{ brand: "Betül Saday", source: source({ byName: { "1001": order("#1001", ["905550000000"]) } }) }, { brand: "MAIUS", source: source({ byName: { "1001": order("#1001", [WA]) } }) }],
      WA,
    );
    expect(await src.byName("1001")).toMatchObject({ brand: "MAIUS" });
  });

  it("telefonla arama bütün markaların siparişlerini yeniden eskiye getirir", async () => {
    const src = compositeOrderSource(
      [{ brand: "Betül Saday", source: source({ phone: [order("#1001", [WA], 5)] }) }, { brand: "MAIUS", source: source({ phone: [order("#MO-1", [WA], 20), order("#MO-0", [WA], 1)] }) }],
      WA,
    );
    expect((await src.byPhone(WA)).map((o) => [o.name, o.brand])).toEqual([["#MO-1", "MAIUS"], ["#1001", "Betül Saday"], ["#MO-0", "MAIUS"]]);
  });

  it("bir marka hata verirse diğerinin sonucu kullanılır; hiçbiri bulamayıp biri hata verdiyse hata yükselir (bulunamadı denmez)", async () => {
    const ok = { brand: "MAIUS", source: source({ byName: { "MO-1": order("#MO-1") }, phone: [order("#MO-1")] }) };
    const broken = { brand: "Betül Saday", source: source({ fail: true }) };
    const mixed = compositeOrderSource([broken, ok], WA);
    expect((await mixed.byName("MO-1"))!.name).toBe("#MO-1");
    expect(await mixed.byPhone(WA)).toHaveLength(1);
    await expect(mixed.byName("yok")).rejects.toThrow("Shopify hatası");
    const noneFound = compositeOrderSource([broken, { brand: "MAIUS", source: source({}) }], WA);
    await expect(noneFound.byPhone(WA)).rejects.toThrow("Shopify hatası");
    // İkisi de sağlam ve bulunamadıysa gerçekten yok.
    expect(await compositeOrderSource([{ brand: "A", source: source({}) }, { brand: "B", source: source({}) }], WA).byName("1")).toBeNull();
  });
});

describe("siparişte ve üründe marka görünür", () => {
  it("sipariş kartı ve sipariş listesi markayı yazar; markasız (tek mağaza) siparişte satır yoktur", () => {
    const now = new Date("2026-09-28T09:00:00Z");
    const withBrand = { ...order("#MO-1271"), brand: "MAIUS" };
    expect(buildOrderSheet(withBrand, new Map(), now, "Europe/Istanbul").text).toContain("Marka: MAIUS");
    expect(buildOrderSheet(order("#MO-1271"), new Map(), now, "Europe/Istanbul").text).not.toContain("Marka:");
    expect(orderSummaryLine(withBrand, "Europe/Istanbul")).toContain("#MO-1271 (MAIUS) ·");
    expect(orderSummaryLine(order("#MO-1271"), "Europe/Istanbul")).toContain("#MO-1271 ·");
  });

  it("ürün özeti markayı yazar", () => {
    const p: ProductFacts = { title: "Zen Takım", url: null, tags: [], description: "", currency: "TRY", variants: [], brand: "MAIUS" };
    expect(describeProducts([p])).toContain("Marka: MAIUS");
    expect(describeProducts([{ ...p, brand: undefined }])).not.toContain("Marka:");
  });
});

describe("birleşik ürün kaynağı", () => {
  const product = (title: string): ProductFacts => ({ title, url: null, tags: [], description: "", currency: "TRY", variants: [] });
  const productSource = (items: ProductFacts[], fail = false): ProductSource => ({
    async search() {
      if (fail) throw new Error("Shopify hatası");
      return items;
    },
  });

  it("ürünlere marka yazılır; biri hata verirse diğeri yeter; hiçbiri bulamayıp biri hata verdiyse hata yükselir", async () => {
    const both = compositeProductSource([{ brand: "Betül Saday", source: productSource([product("Mira Gömlek")]) }, { brand: "MAIUS", source: productSource([product("Zen Takım")]) }]);
    expect((await both.search("x")).map((p) => [p.title, p.brand])).toEqual([["Mira Gömlek", "Betül Saday"], ["Zen Takım", "MAIUS"]]);
    const mixed = compositeProductSource([{ brand: "Betül Saday", source: productSource([], true) }, { brand: "MAIUS", source: productSource([product("Zen Takım")]) }]);
    expect((await mixed.search("x"))[0]).toMatchObject({ title: "Zen Takım", brand: "MAIUS" });
    const none = compositeProductSource([{ brand: "Betül Saday", source: productSource([], true) }, { brand: "MAIUS", source: productSource([]) }]);
    await expect(none.search("x")).rejects.toThrow("Shopify hatası");
  });
});

describe("çok markalı hat: konuşma akışı", () => {
  let database: Database;
  let primary: Tenant;
  let linked: Tenant;
  let conversationId: string;
  let seen: { lina: Anthropic.MessageCreateParamsNonStreaming[]; knowledge: Anthropic.MessageCreateParamsNonStreaming[] };
  const sent: string[] = [];
  const masterKey = randomBytes(32).toString("base64");

  const base = { id: "m", type: "message", role: "assistant", model: "x", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const toolUse = (name: string, input: unknown) => ({ ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: `t-${name}`, name, input }] }) as unknown as Anthropic.Message;
  const text = (t: string) => ({ ...base, stop_reason: "end_turn", content: [{ type: "text", text: t, citations: null }] }) as unknown as Anthropic.Message;

  const llm: Llm = {
    async create(params) {
      const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
      const last = (params.messages.at(-1)!.content as Anthropic.ContentBlockParam[])[0]!;
      if (system.includes("bilgi uzmanısın")) {
        seen.knowledge.push(structuredClone(params));
        return text("Bilgi uzmanı cevabı");
      }
      seen.lina.push(structuredClone(params));
      if (last.type === "tool_result") return text("Hangi markadan soruyorsunuz?");
      return toolUse("ask_store_info_agent", { question: "Kargo kaç günde gelir?" });
    },
  };
  const deps = (over: Partial<Deps> = {}): Deps => ({
    db: database.db, llm, masterKey, model: "m", historyLimit: 20, timeZone: "Europe/Istanbul",
    log: { info() {}, warn() {}, error() {} },
    wa: { sendText: async ({ text: t }) => { sent.push(t); return ["w"]; }, markReadAndTyping: async () => {}, downloadMedia: async () => { throw new Error("yok"); } },
    ...over,
  });
  const ctl = { signal: new AbortController().signal, isCurrent: () => true };

  beforeAll(async () => {
    database = await openDatabase({});
    const { db } = database;
    [linked] = (await db.insert(tenants).values({ slug: "maius", name: "MAIUS", domain: "maiusonline.com", notes: "MAIUS pazar günü kapalı." }).returning()) as [Tenant];
    [primary] = (await db
      .insert(tenants)
      .values({ slug: "betulsaday", name: "Betül Saday", domain: "betulsaday.com", notes: "Bu hafta kargoda gecikme var.", settings: { linkedTenantIds: [linked.id, randomUUID()] } })
      .returning()) as [Tenant];
    await db.insert(knowledgeDocs).values([
      { tenantId: primary.id, source: "policy", externalId: "SHIPPING", title: "Kargo politikası", content: "Betül Saday: kargo 2 gün.", kind: "core", autoEnabled: true },
      { tenantId: linked.id, source: "policy", externalId: "SHIPPING", title: "Kargo politikası", content: "MAIUS: kargo 5 gün.", kind: "core", autoEnabled: true },
    ]);
    const [acc] = await db.insert(whatsappAccounts).values({ tenantId: primary.id, phoneNumberId: "pn", accessTokenEnc: encryptSecret("t", masterKey) }).returning();
    const [c] = await db.insert(customers).values({ tenantId: primary.id, waId: WA, name: "Ayşe" }).returning();
    const [conv] = await db.insert(conversations).values({ tenantId: primary.id, customerId: c!.id, whatsappAccountId: acc!.id }).returning();
    conversationId = conv!.id;
  });
  afterAll(() => database.close());

  const ask = async (over: Partial<Deps> = {}) => {
    seen = { lina: [], knowledge: [] };
    sent.length = 0;
    await database.db.insert(messages).values({ tenantId: primary.id, conversationId, sender: "customer", text: "Kargo kaç günde gelir?" });
    return respond(deps(over), conversationId, ctl);
  };

  it("bağlı mağaza var olan ayar kimliklerinden bulunur; olmayan kimlik atlanır", async () => {
    expect((await loadBrands(database.db, primary)).map((t) => t.slug)).toEqual(["betulsaday", "maius"]);
    expect((await loadBrands(database.db, linked)).map((t) => t.slug)).toEqual(["maius"]);
  });

  it("Lina markaları bilir; bilgi uzmanı iki markanın kaynaklarını ve notlarını başlıklarıyla görür", async () => {
    expect(await ask()).toBe("replied");
    const lina = (seen.lina[0]!.system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
    expect(lina).toContain("## Markalar");
    expect(lina).toContain("Betül Saday (betulsaday.com), MAIUS (maiusonline.com)");
    const knowledge = (seen.knowledge[0]!.system as Anthropic.TextBlockParam[])[0]!.text;
    expect(knowledge).toContain("[Betül Saday] Kargo politikası");
    expect(knowledge).toContain("[MAIUS] Kargo politikası");
    expect(knowledge).toContain("Betül Saday: kargo 2 gün.");
    expect(knowledge).toContain("MAIUS: kargo 5 gün.");
    expect(knowledge).toContain("Hat geneli (bütün markalar için): Bu hafta kargoda gecikme var.");
    expect(knowledge).toContain("[MAIUS] MAIUS pazar günü kapalı.");
    expect(knowledge).toContain("her markanın cevabını ayrı yaz");
    expect(sent).toEqual(["Merhaba, ben Lina. Hangi markadan soruyorsunuz?"]);
  });

  it("bağlantılar yok sayılırsa (deneme verisi) Lina tek marka gibi çalışır", async () => {
    await ask({ singleBrand: true });
    const lina = (seen.lina[0]!.system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
    expect(lina).not.toContain("## Markalar");
    const knowledge = (seen.knowledge[0]!.system as Anthropic.TextBlockParam[])[0]!.text;
    expect(knowledge).toContain("Betül Saday: kargo 2 gün.");
    expect(knowledge).not.toContain("MAIUS: kargo 5 gün.");
    expect(knowledge).not.toContain("[Betül Saday]");
  });

  it("markalara sipariş ve ürün kaynakları ayrı ayrı sorulur", async () => {
    const asked: string[] = [];
    await ask({
      orderSourceFor: async (id) => { asked.push(`sipariş:${id === primary.id ? "betulsaday" : "maius"}`); return source({}); },
      productSourceFor: async (id) => { asked.push(`ürün:${id === primary.id ? "betulsaday" : "maius"}`); return { search: async () => [] }; },
    });
    expect(asked.sort()).toEqual(["sipariş:betulsaday", "sipariş:maius", "ürün:betulsaday", "ürün:maius"]);
    const tools = (seen.lina[0]!.tools as Anthropic.Tool[]).map((t) => t.name);
    expect(tools).toContain("ask_order_agent");
    expect(tools).toContain("ask_product_agent");
  });

  it("kayıtlı bağlantı kalıcıdır: ayar veritabanında", async () => {
    const [row] = await database.db.select().from(tenants).where(eq(tenants.id, primary.id));
    expect((row!.settings as { linkedTenantIds: string[] }).linkedTenantIds).toContain(linked.id);
  });
});
