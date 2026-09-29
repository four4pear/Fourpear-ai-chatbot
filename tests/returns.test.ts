import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askOrderAgent, newFindings } from "../src/agents/orders.js";
import type { Llm } from "../src/agents/runner.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { integrations, tenants, type Tenant } from "../src/db/schema.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { demoOrderSource } from "../src/orders/demo.js";
import { McpClient, kolayIadeProvider, sameReturnOrder } from "../src/returns/kolay-iade.js";
import { returnsProviderFor, type ReturnsProvider } from "../src/returns/provider.js";

const URL_ = "https://iade.test/mcp.php";
const KEY = "lina-test-anahtari";

/** Sahte Kolay İade sunucusu: JSON-RPC isteklerini kaydeder; talep_detay cevabı SSE biçiminde gelir. */
function fakeServer(opts: { emptyFirstSearch?: boolean; rows?: Record<string, unknown>[]; detailStore?: string } = {}) {
  const requests: { method: string; params: Record<string, unknown>; key: string | null }[] = [];
  let searches = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { id?: number; method: string; params: Record<string, unknown> };
    requests.push({ method: body.method, params: body.params, key: new Headers(init!.headers).get("x-iade-key") });
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    if (body.method === "initialize") return ok({ protocolVersion: "2025-06-18", serverInfo: { name: "iade-panel" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return ok({ tools: [{ name: "talep_ara" }, { name: "talep_detay" }, { name: "sql" }] });
    const { name, arguments: args } = body.params as { name: string; arguments: Record<string, unknown> };
    if (name === "talep_ara") {
      searches++;
      if (opts.emptyFirstSearch && searches === 1) return ok({ content: [{ type: "text", text: JSON.stringify({ talepler: [] }) }] });
      const talepler = opts.rows ?? [
        {
          kod: "IAD-2026-1",
          siparis_no: "#MO-9002",
          magaza: "maius",
          durum: "RECEIVED",
          tur: "REFUND",
          musteri_adi: "Ayşe Yılmaz",
          musteri_telefon: "05321234567",
          musteri_eposta: "ayse@ornek.com",
        },
        { kod: "IAD-2026-2", siparis_no: "#MO-9002", magaza: "betulsaday", durum: "PENDING" },
        { kod: "IAD-2026-3", siparis_no: "#MO-19002", magaza: "maius", durum: "PENDING" },
      ];
      return ok({ content: [{ type: "text", text: JSON.stringify({ sorgu: args.sorgu, talepler }) }] });
    }
    if (name === "talep_detay") {
      const detail = {
        talep: {
          kod: args.kod,
          siparis_no: "#MO-9002",
          ...(opts.detailStore ? { magaza: opts.detailStore } : {}),
          durum: "RECEIVED",
          tur: "REFUND",
          olusturma_tarihi: "2026-09-20 10:00",
          gecmis: [
            { durum: "PENDING", tarih: "2026-09-20" },
            { durum: "APPROVED", tarih: "2026-09-21", not: "personel notu: müşteri aradı" },
            { durum: "RECEIVED", tarih: "2026-09-24" },
          ],
          kargo_kodu: "DHL123456",
          kargo_firmasi: "DHL",
          iban: "TR00 0000 1111 2222",
          teslimat_adresi: "Moda Cad. No:1 Kadıköy",
          personel_notu: "iç not: indirim uygulanmadı",
          urunler: [{ baslik: "Riva Takım", varyant: "Vizon", adet: 1, islem: "REFUND", fiyat: 2160, neden_detay: "beden olmadı" }],
        },
        musteri: { ad: "Ayşe Yılmaz", telefon: "0532 123 45 67" },
      };
      const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(detail) }] } })}\n\n`;
      return new Response(sse, { status: 200 });
    }
    return ok({ isError: true, content: [{ type: "text", text: "bilinmeyen araç" }] });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("Kolay İade bağlantısı", () => {
  it("izin verilmeyen araç koddan hiç çağrılamaz", async () => {
    const { fetchImpl, requests } = fakeServer();
    const client = new McpClient({ url: URL_, key: KEY, fetch: fetchImpl });
    await expect(client.callTool("sql" as never, { sorgu: "select * from talepler" })).rejects.toThrow(/İzin verilmeyen araç/);
    await expect(client.callTool("kupon_olustur" as never, {})).rejects.toThrow(/İzin verilmeyen araç/);
    expect(requests).toHaveLength(0);
  });

  it("yalnızca müşteriye söylenebilecek alanlar gelir; başka mağazanın ve siparişin talebi elenir", async () => {
    const { fetchImpl, requests } = fakeServer();
    const result = await kolayIadeProvider({ url: URL_, key: KEY, store: "maius", fetch: fetchImpl }).requestsFor("#MO-9002");

    expect(result).toEqual([
      {
        code: "IAD-2026-1",
        type: "REFUND",
        status: "RECEIVED",
        createdAt: "2026-09-20 10:00",
        history: [
          { status: "PENDING", at: "2026-09-20" },
          { status: "APPROVED", at: "2026-09-21" },
          { status: "RECEIVED", at: "2026-09-24" },
        ],
        returnShippingCode: "DHL123456",
        carrier: "DHL",
        items: [{ title: "Riva Takım", variant: "Vizon", quantity: 1, action: "REFUND" }],
      },
    ]);
    const all = JSON.stringify(result);
    for (const secret of ["Ayşe", "0532", "05321234567", "ayse@", "TR00", "Moda", "iç not", "personel", "2160", "beden olmadı"]) {
      expect(all).not.toContain(secret);
    }
    // Anahtar başlıkta gider; yalnızca iki okuma aracı çağrılır.
    expect(requests.every((r) => r.key === KEY)).toBe(true);
    const tools = requests.filter((r) => r.method === "tools/call").map((r) => r.params.name);
    expect(tools).toEqual(["talep_ara", "talep_detay"]);
    expect(requests.find((r) => r.method === "tools/call")!.params.arguments).toEqual({ sorgu: "#MO-9002", magaza: "maius", limit: 10 });
  });

  it("panel numarayı farklı yazıyorsa sadece rakamlarla yeniden arar", async () => {
    const { fetchImpl, requests } = fakeServer({ emptyFirstSearch: true });
    const result = await kolayIadeProvider({ url: URL_, key: KEY, store: "maius", fetch: fetchImpl }).requestsFor("#MO-9002");
    expect(result).toHaveLength(1);
    const searches = requests.filter((r) => r.method === "tools/call" && r.params.name === "talep_ara");
    expect(searches.map((s) => (s.params.arguments as { sorgu: string }).sorgu)).toEqual(["#MO-9002", "9002"]);
  });

  it("sipariş numarası öneki dahil eşleşmeli: başka mağazanın aynı numaralı siparişi karışmaz", () => {
    expect(sameReturnOrder("MO-9002", "#MO-9002")).toBe(true);
    expect(sameReturnOrder("#mo-9002", "#MO-9002")).toBe(true);
    expect(sameReturnOrder("9002", "#MO-9002")).toBe(true);
    expect(sameReturnOrder("#BS-9002", "#MO-9002")).toBe(false);
    expect(sameReturnOrder("#MO-19002", "#MO-9002")).toBe(false);
  });

  it("mağazası yazmayan ya da başka önekli talep gösterilmez; mağaza ayrıntıda doğrulanır", async () => {
    // Arama satırlarında mağaza yok; ayrıntı başka mağazayı söylüyor → gösterilmez.
    const otherStore = fakeServer({ rows: [{ kod: "IAD-9", siparis_no: "#MO-9002", durum: "PENDING" }], detailStore: "betulsaday" });
    expect(await kolayIadeProvider({ url: URL_, key: KEY, store: "maius", fetch: otherStore.fetchImpl }).requestsFor("#MO-9002")).toEqual([]);

    // Ayrıntı bizim mağazayı söylüyor → gösterilir.
    const ours = fakeServer({ rows: [{ kod: "IAD-9", siparis_no: "#MO-9002", durum: "PENDING" }], detailStore: "maius" });
    expect(await kolayIadeProvider({ url: URL_, key: KEY, store: "maius", fetch: ours.fetchImpl }).requestsFor("#MO-9002")).toHaveLength(1);

    // Hiçbir yerde mağaza yok → emin olunamaz, gösterilmez.
    const unknown = fakeServer({ rows: [{ kod: "IAD-9", siparis_no: "#MO-9002", durum: "PENDING" }] });
    expect(await kolayIadeProvider({ url: URL_, key: KEY, store: "maius", fetch: unknown.fetchImpl }).requestsFor("#MO-9002")).toEqual([]);

    // Aynı numara, başka önek (#BS-9002) → gösterilmez; ayrıntı hiç istenmez.
    const prefixed = fakeServer({ rows: [{ kod: "IAD-8", siparis_no: "#BS-9002", magaza: "maius", durum: "PENDING" }] });
    expect(await kolayIadeProvider({ url: URL_, key: KEY, store: "maius", fetch: prefixed.fetchImpl }).requestsFor("#MO-9002")).toEqual([]);
    expect(prefixed.requests.some((r) => r.method === "tools/call" && r.params.name === "talep_detay")).toBe(false);
  });

  it("bağlantı testi anahtarın görebildiği araçları listeler", async () => {
    const { fetchImpl } = fakeServer();
    expect(await new McpClient({ url: URL_, key: KEY, fetch: fetchImpl }).listTools()).toEqual(["talep_ara", "talep_detay", "sql"]);
  });
});

describe("iade sistemi mağaza ayarı", () => {
  let database: Database;
  let tenant: Tenant;
  const MASTER_KEY = randomBytes(32).toString("base64");

  beforeAll(async () => {
    database = await openDatabase({});
    [tenant] = (await database.db.insert(tenants).values({ slug: "maius", name: "MAIUS" }).returning()) as [Tenant];
  });
  afterAll(() => database.close());

  it("bağlantı yoksa ya da kapalıysa sağlayıcı yok; açıksa anahtar çözülür", async () => {
    expect(await returnsProviderFor(database.db, MASTER_KEY, tenant.id)).toBeNull();
    await database.db.insert(integrations).values({
      tenantId: tenant.id,
      kind: "returns_mcp",
      config: { url: URL_, store: "maius" },
      secretEnc: encryptSecret(KEY, MASTER_KEY),
    });
    expect(await returnsProviderFor(database.db, MASTER_KEY, tenant.id)).not.toBeNull();
    await database.db.update(integrations).set({ enabled: false });
    expect(await returnsProviderFor(database.db, MASTER_KEY, tenant.id)).toBeNull();
  });

  it("iade sorusunda sipariş kartına talebin durumu eklenir", async () => {
    const orderCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const llm: Llm = {
      async create(params) {
        orderCalls.push(params);
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "x",
          content: [{ type: "text", text: "tamam", citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    };
    const returns: ReturnsProvider = {
      async requestsFor(orderName) {
        return orderName === "#MO-9002"
          ? [
              {
                code: "IAD-2026-1",
                type: "REFUND",
                status: "RECEIVED",
                createdAt: "2026-09-20",
                history: [],
                returnShippingCode: "DHL123456",
                carrier: "DHL",
                items: [],
              },
            ]
          : [];
      },
    };
    await askOrderAgent(
      { db: database.db, llm, model: "m", tenantId: tenant.id, conversationId: null },
      tenant,
      { source: demoOrderSource(() => "905321234567"), waId: "905321234567", timeZone: "Europe/Istanbul", now: new Date("2026-09-28T09:00:00Z"), returns },
      { topic: "return_status", question: "İadem ne oldu?", orderNumber: "MO-9002" },
      newFindings(),
    );
    const content = orderCalls[0]!.messages[0]!.content as string;
    expect(content).toContain("İADE TALEBİ (iade sisteminden):");
    expect(content).toContain("Talep IAD-2026-1 (para iadesi): ürün depoya ulaştı");
    expect(content).toContain("İade kargo kodu: DHL123456 (DHL)");
  });
});
