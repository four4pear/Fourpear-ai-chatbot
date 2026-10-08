import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLina } from "../src/agents/lina.js";
import type { Llm } from "../src/agents/runner.js";
import { agentRuns, tenants, type ShopifyStore, type Tenant } from "../src/db/schema.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { businessStatus } from "../src/core/business-hours.js";
import { demoProductSource } from "../src/products/demo.js";
import { shopifyProductSource, toProductFacts } from "../src/products/shopify.js";
import { describeProducts, sanitizeQuery, stockState, type ProductFacts } from "../src/products/types.js";
import type { ShopifyApi } from "../src/shopify/client.js";

describe("stok durumu", () => {
  it("satılamıyorsa tükendi; sayı sıfırken satılabiliyorsa ön sipariş; 3 ve altı az kaldı", () => {
    expect(stockState({ availableForSale: false, inventoryQuantity: 0 })).toBe("sold_out");
    expect(stockState({ availableForSale: true, inventoryQuantity: 0 })).toBe("backorder");
    expect(stockState({ availableForSale: true, inventoryQuantity: -2 })).toBe("backorder");
    expect(stockState({ availableForSale: true, inventoryQuantity: 1 })).toBe("low");
    expect(stockState({ availableForSale: true, inventoryQuantity: 3 })).toBe("low");
    expect(stockState({ availableForSale: true, inventoryQuantity: 4 })).toBe("in_stock");
    // Stok takibi kapalı ürün (adet yok) satılabiliyorsa stokta sayılır.
    expect(stockState({ availableForSale: true, inventoryQuantity: null })).toBe("in_stock");
  });
});

describe("ürün özeti", () => {
  const product: ProductFacts = {
    title: "Riva Takım",
    url: "https://magaza.test/products/riva",
    tags: ["takım"],
    description: "İki parça takım.",
    currency: "TRY",
    variants: [
      { title: "Vizon / 36", price: 2490, compareAtPrice: 3290, stock: "in_stock" },
      { title: "Vizon / 38", price: 2490, compareAtPrice: 3290, stock: "low" },
      { title: "Vizon / 40", price: 2490, compareAtPrice: 3290, stock: "sold_out" },
    ],
  };

  it("fiyat, indirim, seçenek durumu ve ürün yazısı yazılır; stok adedi hiçbir yerde geçmez", () => {
    const text = describeProducts([product]);
    expect(text).toContain("Riva Takım — https://magaza.test/products/riva");
    expect(text).toContain("Fiyat: 2.490 TL (indirimli; önceki fiyat 3.290 TL)");
    expect(text).toContain("- Vizon / 36: stokta var");
    expect(text).toContain("- Vizon / 38: az sayıda kaldı");
    expect(text).toContain("- Vizon / 40: tükendi");
    expect(text).toContain("İki parça takım.");
  });

  it("değişen fiyatlarda aralık yazılır; indirimsiz ürüne 'indirimli' denmez; eşleşme yoksa açık söyler", () => {
    const text = describeProducts([{ ...product, variants: [{ title: "S", price: 100, compareAtPrice: null, stock: "in_stock" }, { title: "M", price: 120.5, compareAtPrice: null, stock: "in_stock" }] }]);
    expect(text).toContain("Fiyat: 100 TL – 120,5 TL");
    expect(text).not.toContain("indirimli");
    expect(describeProducts([])).toBe("Eşleşen aktif ürün bulunamadı.");
  });
});

describe("arama metni", () => {
  it("Shopify arama operatörlerini ve tırnakları atar", () => {
    expect(sanitizeQuery('Zen Takım status:draft OR "gizli"')).toBe("Zen Takım status draft gizli");
    expect(sanitizeQuery("  lavin   etek  ")).toBe("lavin etek");
    expect(sanitizeQuery(":::")).toBe("");
    expect(sanitizeQuery("a".repeat(500))).toHaveLength(120);
  });
});

describe("Shopify ürün kaynağı", () => {
  const store = { id: "s1", shopDomain: "magaza.myshopify.com" } as unknown as ShopifyStore;
  const node = {
    title: "Zen Takım",
    onlineStoreUrl: "https://magaza.test/products/zen",
    tags: ["keten"],
    description: "Keten   karışımlı\n takım.",
    variants: {
      nodes: [
        { title: "Haki / 36", availableForSale: true, inventoryQuantity: 7, price: "2190.00", compareAtPrice: null },
        { title: "Haki / 38", availableForSale: true, inventoryQuantity: 2, price: "2190.00", compareAtPrice: "2490.00" },
        { title: "Haki / 40", availableForSale: false, inventoryQuantity: 0, price: "2190.00", compareAtPrice: null },
        { title: "Default Title", availableForSale: true, inventoryQuantity: null, price: "99.00", compareAtPrice: null },
      ],
    },
  };

  it("aktif ürünleri arar, operatörleri temizler ve varyantları stok durumuna çevirir", async () => {
    const calls: { query: string; first: number }[] = [];
    const api: ShopifyApi = {
      async graphql<T>(_store: ShopifyStore, _q: string, variables?: Record<string, unknown>) {
        calls.push(variables as { query: string; first: number });
        return { products: { nodes: [node] } } as T;
      },
    };
    const [p] = await shopifyProductSource(api, store).search('Zen Takım "status:draft"');
    expect(calls[0]).toEqual({ query: "Zen Takım status draft status:active", first: 5 });
    expect(p!.description).toBe("Keten karışımlı takım.");
    expect(p!.variants.map((v) => [v.title, v.stock, v.price])).toEqual([
      ["Haki / 36", "in_stock", 2190],
      ["Haki / 38", "low", 2190],
      ["Haki / 40", "sold_out", 2190],
      ["Standart", "in_stock", 99],
    ]);
    expect(p!.variants[1]!.compareAtPrice).toBe(2490);
    // Boş arama Shopify'a gitmez.
    expect(await shopifyProductSource(api, store).search("::")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("toProductFacts para birimini taşır", () => {
    expect(toProductFacts(node, "EUR").currency).toBe("EUR");
  });
});

describe("deneme ürünleri", () => {
  it("harf farklarını yok sayar; bütün sözcükler eşleşmeli", async () => {
    const src = demoProductSource();
    expect((await src.search("zen takim")).map((p) => p.title)).toEqual(["Zen Takım"]);
    expect((await src.search("LAVİN")).map((p) => p.title)).toEqual(["Maius Lavin Etek"]);
    expect((await src.search("takım")).map((p) => p.title).sort()).toEqual(["Maius Riva Takım", "Zen Takım"]);
    expect(await src.search("zen etek")).toEqual([]);
    expect(await src.search("  ")).toEqual([]);
  });
});

describe("Lina ve ürün uzmanı", () => {
  let database: Database;
  let tenant: Tenant;
  beforeAll(async () => {
    database = await openDatabase({});
    [tenant] = (await database.db.insert(tenants).values({ slug: "betulsaday", name: "Betül Saday" }).returning()) as [Tenant];
  });
  afterAll(() => database.close());

  const base = { id: "m", type: "message", role: "assistant", model: "x", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const toolUse = (name: string, input: unknown) => ({ ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: `t-${name}`, name, input }] }) as unknown as Anthropic.Message;
  const text = (t: string) => ({ ...base, stop_reason: "end_turn", content: [{ type: "text", text: t, citations: null }] }) as unknown as Anthropic.Message;
  const lastBlock = (p: Anthropic.MessageCreateParamsNonStreaming) => (p.messages.at(-1)!.content as Anthropic.ContentBlockParam[])[0]!;

  function scripted() {
    const seen: { lina: Anthropic.MessageCreateParamsNonStreaming[]; product: Anthropic.MessageCreateParamsNonStreaming[] } = { lina: [], product: [] };
    const llm: Llm = {
      async create(params) {
        const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
        const isProduct = system.includes("ürün uzmanısın");
        (isProduct ? seen.product : seen.lina).push(structuredClone(params));
        const last = lastBlock(params);
        if (isProduct) {
          if (last.type === "tool_result") return text(`ÜRÜN UZMANI: ${String((last as Anthropic.ToolResultBlockParam).content)}`);
          return toolUse("search_products", { query: "Maius Lavin" });
        }
        if (last.type === "tool_result") return text(`Lina: ${String((last as Anthropic.ToolResultBlockParam).content)}`);
        return toolUse("ask_product_agent", { question: "Lavin Etek siyah 38 var mı?" });
      },
    };
    return { llm, seen };
  }
  const turn = { firstContact: false, business: businessStatus({ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }, "Europe/Istanbul"), openHandoff: null, memory: null, askedTeam: [], teamAnswers: { fresh: [], earlier: [] } };
  const history: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: "Lavin etek siyah 38 beden var mı?" }] }];

  it("ürün kaynağı varsa Lina ürün uzmanına sorar; uzman Shopify aramasının sonucunu okur; stok adedi geçmez", async () => {
    const { llm, seen } = scripted();
    const ctx = { db: database.db, llm, model: "m", tenantId: tenant.id, conversationId: null };
    const result = await runLina(ctx, tenant, history, turn, null, null, [], { source: demoProductSource() });
    expect(result.kind).toBe("reply");
    const reply = (result as { text: string }).text;
    expect(reply).toContain("ÜRÜN UZMANI:");
    expect(reply).toContain("Siyah / 2–40/42: stokta yok, ön sipariş/üretim süreciyle sipariş alınıyor");
    expect(reply).toContain("Kırık Beyaz / 2–40/42: az sayıda kaldı");
    expect(reply).toContain("1.490 TL (indirimli; önceki fiyat 1.990 TL)");
    // Ürün yazısındaki ön sipariş ve kampanya koşulu aynen uzmana gider.
    expect(reply).toContain("ÖN SİPARİŞ");
    // Adetler (12, 2…) yalnızca durum olarak geçer: "12" gibi bir stok sayısı yok.
    expect(reply).not.toMatch(/\b12\b/);
    // Lina'nın araç listesinde ürün uzmanı var; kayıtlar "product" olarak tutulur.
    const tools = (seen.lina[0]!.tools as Anthropic.Tool[]).map((t) => t.name);
    expect(tools).toContain("ask_product_agent");
    const runs = await database.db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenant.id));
    expect(runs.some((r) => r.agent === "product")).toBe(true);
    // Uzmanın arama sorusuna müşterinin son mesajı koddan eklenir.
    expect(JSON.stringify(seen.product[0]!.messages[0])).toContain("Müşterinin son mesajları");
  });

  it("ürün kaynağı yoksa (Shopify bağlı değil) ürün uzmanı açılmaz", async () => {
    const { llm, seen } = scripted();
    // Ürün uzmanı olmadığı için Lina ask_product_agent çağıramaz; sahte model yine de çağırırsa araç bilinmediği için hata alır.
    const ctx = { db: database.db, llm, model: "m", tenantId: tenant.id, conversationId: null };
    await runLina(ctx, tenant, history, turn, null, null, [], null).catch(() => undefined);
    const tools = (seen.lina[0]!.tools as Anthropic.Tool[]).map((t) => t.name);
    expect(tools).not.toContain("ask_product_agent");
    const system = (seen.lina[0]!.system as Anthropic.TextBlockParam[])[0]!.text;
    expect(system).not.toContain("ask_product_agent (ürün uzmanı)");
  });
});
