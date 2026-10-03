import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { recordSnapshot } from "../src/archive/archive.js";
import { productSnapshot, type StorefrontProduct } from "../src/archive/storefront.js";
import { askOrderAgent, newFindings, type OrderFindings } from "../src/agents/orders.js";
import { askReturnsAgent } from "../src/agents/returns.js";
import type { Llm } from "../src/agents/runner.js";
import type { Deps } from "../src/core/conversation.js";
import { EventBus, type PanelEvent } from "../src/core/events.js";
import { classifyFindings } from "../src/core/notifications.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { conversations, customers, handoffs, notifications, tenants, whatsappAccounts, type Tenant } from "../src/db/schema.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { demoOrderSource, demoReturnsProvider } from "../src/orders/demo.js";
import { buildOrderSheet, findDate, preorderFor, specialLines, type ProductTextAt } from "../src/orders/facts.js";
import { shopifyOrderSource } from "../src/orders/shopify.js";
import { belongsTo, nameMatches, sameOrderNumber, type OrderFacts, type OrderItem } from "../src/orders/types.js";
import type { ShopifyApi } from "../src/shopify/client.js";
import type { WhatsAppSender } from "../src/whatsapp/client.js";

const TZ = "Europe/Istanbul";
/** 28 Eylül 2026 12:00 İstanbul: Lavin Etek'in ön sipariş tarihi (25 Eylül) geçmiş. */
const NOW = new Date("2026-09-28T09:00:00Z");
const CUSTOMER = "905321234567";

const PREORDER_SIYAH =
  "🕒 ÖN SİPARİŞ: Siyah renk ön sipariş kapsamındadır; siparişler 25 Eylül tarihinde kargoya teslim edilir. Kırık Beyaz renk stoktan çıkmaktadır.";
const CAMPAIGN =
  "🍂 SONBAHAR İNDİRİMİ: Bu ürün 30 Eylül'e kadar indirimli fiyatla satışa sunulmaktadır. Sonbahar İndirimi kapsamında indirimli ürünlerde 14 günlük iade ve değişim uygulanmamaktadır; yalnızca hasarlı, hatalı veya yanlış gönderilen ürünlerde değişim veya iade yapılır.";
const LAVIN_TEXT = [PREORDER_SIYAH, CAMPAIGN, "Poplin kumaştan üretilmektedir."].join("\n");

function lavinItem(color: "Siyah" | "Kırık Beyaz", unfulfilled = 1): OrderItem {
  return {
    id: `li-${color}`,
    productId: "10094861484281",
    title: "Maius Lavin Etek",
    variantTitle: `1–36/38 / ${color}`,
    options: [
      { name: "Beden", value: "1–36/38" },
      { name: "Renk", value: color },
    ],
    productOptionValues: ["1–36/38", "2–40/42", "Kırık Beyaz", "Siyah"],
    quantity: 1,
    unfulfilled,
    currentDescription: LAVIN_TEXT,
  };
}

function order(overrides: Partial<OrderFacts> = {}): OrderFacts {
  return {
    name: "#MO-1271",
    createdAt: new Date("2026-09-12T08:20:00Z"),
    cancelledAt: null,
    phones: [CUSTOMER],
    items: [lavinItem("Siyah")],
    shipments: [],
    ...overrides,
  };
}

const fromArchive = (content: string, opts: Partial<ProductTextAt> = {}): Map<string, ProductTextAt | null> =>
  new Map([
    ["10094861484281", { version: { content, firstSeenAt: new Date("2026-09-10T00:00:00Z") }, confirmed: true, beforeArchive: false, ...opts }],
  ]);

describe("tarih okuma", () => {
  it("Türkçe ve sayısal tarihleri okur, yılı sipariş tarihinden çıkarır", () => {
    expect(findDate("siparişler 25 Eylül tarihinde kargoya", "2026-09-12")).toBe("2026-09-25");
    expect(findDate("30 EYLÜL'e kadar", "2026-09-01")).toBe("2026-09-30");
    expect(findDate("25 eylul", "2026-09-01")).toBe("2026-09-25");
    expect(findDate("kargo tarihi 25.09.2026", "2026-09-01")).toBe("2026-09-25");
    expect(findDate("kargoda 25.09", "2026-09-01")).toBe("2026-09-25");
    // Büyük harf ve noktasız I ile yazılmış ay adı.
    expect(findDate("5 EKIM'de kargoda", "2026-09-01")).toBe("2026-10-05");
    // Aralık siparişinde "5 Ocak": ertesi yıl.
    expect(findDate("5 Ocak'ta kargoya verilir", "2026-12-20")).toBe("2027-01-05");
  });

  it("tarih olmayanları tarih sanmaz", () => {
    expect(findDate("31 Şubat", "2026-01-10")).toBeNull();
    expect(findDate("Beden 36/38", "2026-09-01")).toBeNull();
    expect(findDate("Ekim koleksiyonu", "2026-09-01")).toBeNull();
    // Yılsız "/" kesir olabilir; beden ya da kesirden sonra gelen asıl tarih bulunur.
    expect(findDate("25/09", "2026-09-01")).toBeNull();
    expect(findDate("36/38 beden, 25 Eylül'de kargoda", "2026-09-01")).toBe("2026-09-25");
    expect(findDate("3/4 kollu; siparişler 25 Eylül'de kargoda", "2026-09-01")).toBe("2026-09-25");
  });
});

describe("özel koşullar ve ön sipariş", () => {
  it("kampanya ve ön sipariş satırları aynen çıkarılır", () => {
    expect(specialLines(LAVIN_TEXT)).toEqual([PREORDER_SIYAH, CAMPAIGN]);
  });

  it("'Siyah renk ön sipariş' yalnızca Siyah'ı kapsar; Kırık Beyaz stoktan", () => {
    expect(preorderFor(LAVIN_TEXT, lavinItem("Siyah"), "2026-09-12")).toEqual({
      line: PREORDER_SIYAH,
      date: "2026-09-25",
      applies: true,
      inStock: false,
    });
    expect(preorderFor(LAVIN_TEXT, lavinItem("Kırık Beyaz"), "2026-09-12")).toMatchObject({ applies: false, inStock: true });
  });

  it("renklere ayrı ön sipariş satırları: her varyant kendi tarihini alır", () => {
    const text = "🕒 ÖN SİPARİŞ: Siyah renk 25 Eylül'de kargoya verilir.\n🕒 ÖN SİPARİŞ: Kırık Beyaz renk 5 Ekim'de kargoya verilir.";
    expect(preorderFor(text, lavinItem("Siyah"), "2026-09-12")).toMatchObject({ date: "2026-09-25", applies: true });
    expect(preorderFor(text, lavinItem("Kırık Beyaz"), "2026-09-12")).toMatchObject({ date: "2026-10-05", applies: true });
  });

  it("yazı bu varyantı anmıyor ve 'stok' da demiyorsa 'stoktan' denmez, gecikme de açılmaz", () => {
    const text = "🕒 ÖN SİPARİŞ: Siyah renk 25 Eylül'de kargoya verilir.";
    expect(preorderFor(text, lavinItem("Kırık Beyaz"), "2026-09-12")).toMatchObject({ applies: false, inStock: false });
    const sheet = buildOrderSheet(order({ items: [{ ...lavinItem("Kırık Beyaz"), currentDescription: text }] }), new Map(), NOW, TZ);
    expect(sheet.text).toContain("bu varyantın ön sipariş olup olmadığı açıklamadan anlaşılamıyor");
    expect(sheet.issues).toEqual([]);
  });

  it("renk anmayan ön sipariş bütün ürünü kapsar; tarih sonraki satırda da olabilir", () => {
    const whole = "🕒 ÖN SİPARİŞ: Bu ürün ön sipariş kapsamındadır.\nSiparişler 25 Eylül tarihinde kargoya teslim edilir.";
    expect(preorderFor(whole, lavinItem("Kırık Beyaz"), "2026-09-12")).toMatchObject({ date: "2026-09-25", applies: true });
  });
});

describe("sipariş bilgi kartı", () => {
  it("tarihi geçen ön sipariş: GECİKME ve ekibe bildirim; kampanya satırı en başta", () => {
    const sheet = buildOrderSheet(order(), fromArchive(LAVIN_TEXT), NOW, TZ);
    expect(sheet.text).toContain("planlanan kargo 25 Eylül 2026; tarih geçti, ürün henüz kargoya verilmedi: GECİKME");
    expect(sheet.issues).toEqual([
      { kind: "delay", orderName: "#MO-1271", text: "Gecikme: Maius Lavin Etek (1–36/38 / Siyah), planlanan kargo 25 Eylül 2026" },
    ]);
    expect(sheet.unshipped).toBe(true);
    expect(sheet.text.indexOf(`• ${CAMPAIGN}`)).toBeGreaterThan(-1);
    expect(sheet.text.indexOf(`• ${CAMPAIGN}`)).toBeLessThan(sheet.text.indexOf("Ürün açıklaması (tamamı)"));
    expect(sheet.text).toContain("Paylaşılmaz: tutar, ödeme bilgisi, adres.");
    // Doğrulama telefonu karta hiç girmez.
    expect(sheet.text).not.toContain("532");
  });

  it("tarih gelmediyse gecikme yok; stoktaki varyantta ön sipariş uygulanmaz", () => {
    const early = buildOrderSheet(order(), fromArchive(LAVIN_TEXT), new Date("2026-09-20T09:00:00Z"), TZ);
    expect(early.text).toContain("planlanan kargo 25 Eylül 2026; tarih henüz gelmedi");
    expect(early.issues).toEqual([]);

    const white = buildOrderSheet(order({ items: [lavinItem("Kırık Beyaz")] }), fromArchive(LAVIN_TEXT), NOW, TZ);
    expect(white.text).toContain("Açıklamaya göre bu varyant stoktan");
    expect(white.issues).toEqual([]);
  });

  it("ön sipariş tarihi sipariş gününde zaten geçmişse (sayfa güncellenmemiş) ekibe bu da yazılır", () => {
    const late = buildOrderSheet(order({ createdAt: new Date("2026-09-26T08:00:00Z") }), fromArchive(LAVIN_TEXT), NOW, TZ);
    expect(late.text).toContain("tarih geçti (bu tarih sipariş verildiğinde de geçmişti; ürün sayfası güncellenmemiş)");
    expect(late.issues).toEqual([
      {
        kind: "delay",
        orderName: "#MO-1271",
        text: "Gecikme: Maius Lavin Etek (1–36/38 / Siyah); ürün sayfasındaki ön sipariş tarihi (25 Eylül 2026) sipariş gününden önce kalmış, sayfa güncellenmeli",
      },
    ]);
  });

  it("iptal edilmiş siparişte gecikme aranmaz", () => {
    const sheet = buildOrderSheet(order({ cancelledAt: new Date("2026-09-15T10:00:00Z") }), fromArchive(LAVIN_TEXT), NOW, TZ);
    expect(sheet.text).toContain("Durum: İptal edildi (15 Eylül 2026)");
    expect(sheet.issues).toEqual([]);
    expect(sheet).toMatchObject({ unshipped: false, cancelled: true });
  });

  it("kampanya yazısı sonradan silinse de sipariş tarihindeki yazı kullanılır, bugünkü farkı da gösterilir", () => {
    const today = { ...lavinItem("Siyah"), currentDescription: "Poplin kumaştan üretilmektedir." };
    const sheet = buildOrderSheet(order({ items: [today] }), fromArchive(LAVIN_TEXT), NOW, TZ);
    expect(sheet.text).toContain(`• ${CAMPAIGN}`);
    expect(sheet.text).toContain("Bugünkü açıklamadaki özel koşullar: yok");
    expect(sheet.text).toContain("kampanya arşivi (sipariş gününde kayıtlı yazı)");
  });

  it("arşiv öncesi sipariş ve arşivsiz ürün açıkça belirtilir", () => {
    const before = buildOrderSheet(order(), fromArchive(LAVIN_TEXT, { beforeArchive: true, confirmed: false }), NOW, TZ);
    expect(before.text).toContain("sipariş bundan önce verildi, o gün aynı yazı olduğu kesin değil");
    const none = buildOrderSheet(order(), new Map(), NOW, TZ);
    expect(none.text).toContain("bugünkü ürün açıklaması (arşivde kayıt yok)");
    expect(none.text).toContain(`• ${CAMPAIGN}`);
  });

  it("kargo: teslim edildi, takip linki; takip numarası yoksa ekibe bildirim", () => {
    const delivered = buildOrderSheet(
      order({
        items: [lavinItem("Kırık Beyaz", 0)],
        shipments: [
          {
            createdAt: new Date("2026-09-17T13:00:00Z"),
            status: "DELIVERED",
            deliveredAt: new Date("2026-09-19T09:30:00Z"),
            carrier: "Yurtiçi Kargo",
            trackingNumber: "100200300401",
            trackingUrl: "https://kargo.test/100200300401",
            itemIds: ["li-Kırık Beyaz"],
            requiresShipping: true,
          },
        ],
      }),
      fromArchive(LAVIN_TEXT),
      NOW,
      TZ,
    );
    expect(delivered.text).toContain("Durum: Teslim edildi (19 Eylül 2026)");
    expect(delivered.text).toContain("takip linki https://kargo.test/100200300401");
    expect(delivered.issues).toEqual([]);

    const noTracking = buildOrderSheet(
      order({
        items: [lavinItem("Kırık Beyaz", 0)],
        shipments: [
          {
            createdAt: new Date("2026-09-26T14:40:00Z"),
            status: "CONFIRMED",
            deliveredAt: null,
            carrier: null,
            trackingNumber: null,
            trackingUrl: null,
            itemIds: ["li-Kırık Beyaz"],
            requiresShipping: true,
          },
        ],
      }),
      fromArchive(LAVIN_TEXT),
      NOW,
      TZ,
    );
    expect(noTracking.text).toContain("Durum: Kargoya verildi");
    expect(noTracking.issues).toEqual([{ kind: "no_tracking", orderName: "#MO-1271", text: "Takip numarası yok: 26 Eylül 2026 tarihli gönderim" }]);
  });

  it("bütün ürünler iade edildiyse 'hazırlanıyor' denmez", () => {
    const refunded = { ...lavinItem("Siyah"), quantity: 0, unfulfilled: 0 };
    const sheet = buildOrderSheet(order({ items: [refunded] }), fromArchive(LAVIN_TEXT), NOW, TZ);
    expect(sheet.text).toContain("Durum: Siparişteki ürünlerin hepsi iade edildi ya da siparişten çıkarıldı");
    expect(sheet.issues).toEqual([]);
  });

  it("mağazadan teslim ve dijital üründe takip numarası beklenmez", () => {
    const shipment = (status: string, requiresShipping: boolean) => ({
      createdAt: new Date("2026-09-26T14:40:00Z"),
      status,
      deliveredAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      itemIds: ["li-Kırık Beyaz"],
      requiresShipping,
    });
    for (const s of [shipment("READY_FOR_PICKUP", true), shipment("PICKED_UP", true), shipment("SUCCESS", false)]) {
      const sheet = buildOrderSheet(order({ items: [lavinItem("Kırık Beyaz", 0)], shipments: [s] }), fromArchive(LAVIN_TEXT), NOW, TZ);
      expect(sheet.issues).toEqual([]);
    }
  });

  it("bir ürün gönderildi, diğeri bekliyor: kısmen kargoda", () => {
    const sheet = buildOrderSheet(
      order({
        items: [lavinItem("Siyah"), lavinItem("Kırık Beyaz", 0)],
        shipments: [
          {
            createdAt: new Date("2026-09-14T13:00:00Z"),
            status: "IN_TRANSIT",
            deliveredAt: null,
            carrier: "Yurtiçi Kargo",
            trackingNumber: "1",
            trackingUrl: null,
            itemIds: ["li-Kırık Beyaz"],
            requiresShipping: true,
          },
        ],
      }),
      fromArchive(LAVIN_TEXT),
      NOW,
      TZ,
    );
    expect(sheet.text).toContain("Durum: Kısmen kargoya verildi");
    expect(sheet.issues.map((i) => i.kind)).toEqual(["delay"]);
  });
});

describe("sahiplik ve sipariş numarası", () => {
  it("ad soyad: büyük/küçük ve Türkçe harf farkı önemsiz, ikinci ad gerekmez; yalnızca ad yetmez", () => {
    const withNames = (...names: string[]) => ({ names }) as OrderFacts;
    expect(nameMatches(withNames("Ayşe Nur Yılmaz"), "ayse yilmaz")).toBe(true);
    expect(nameMatches(withNames("İREM IŞIK"), "İrem Işık")).toBe(true);
    expect(nameMatches(withNames("irem isik"), "IREM IŞIK")).toBe(true);
    expect(nameMatches(withNames("Ayşe Yılmaz"), "Ayşe")).toBe(false);
    expect(nameMatches(withNames("Ayşe Yılmaz"), "Ayşe Kaya")).toBe(false);
    expect(nameMatches(withNames("Ayşe"), "Ayşe Yılmaz")).toBe(false); // siparişte soyad yoksa doğrulanamaz
    expect(nameMatches(withNames("Zeynep Kaya", "Ayşe Yılmaz"), "adım ayşe yılmaz")).toBe(true);
  });

  it("ad soyad: uzun bir isim listesi yazıp tutturmak mümkün değil; siparişteki adda olmayan en fazla bir kelime", () => {
    const withNames = (...names: string[]) => ({ names }) as OrderFacts;
    const stuffed = "Ayşe Fatma Zeynep Elif Merve Yılmaz Kaya Demir Şahin Çelik";
    expect(nameMatches(withNames("Zeynep Kaya"), stuffed)).toBe(false);
    expect(nameMatches(withNames("Zeynep Kaya"), "Zeynep Hanım Kaya")).toBe(true);
    expect(nameMatches(withNames("Zeynep Kaya"), "Ayşe Zeynep Yılmaz Kaya")).toBe(false);
    // İkinci adı siparişte olan müşteri hepsini yazabilir.
    expect(nameMatches(withNames("Ayşe Nur Yılmaz"), "adım Ayşe Nur Yılmaz")).toBe(true);
  });

  it("sipariş yalnızca aynı telefona aittir", () => {
    expect(belongsTo(order(), CUSTOMER)).toBe(true);
    expect(belongsTo(order(), "905551112233")).toBe(false);
    expect(belongsTo(order({ phones: [] }), CUSTOMER)).toBe(false);
  });

  it("müşterinin yazdığı numarayı tanır, benzerini karıştırmaz", () => {
    expect(sameOrderNumber("#MO-1271", "mo 1271")).toBe(true);
    expect(sameOrderNumber("#MO-1271", "#1271")).toBe(true);
    expect(sameOrderNumber("#MO-11271", "1271")).toBe(false);
    expect(sameOrderNumber("#MO-1271", "siparişim")).toBe(false);
  });
});

describe("Shopify sipariş kaynağı", () => {
  const gqlOrder = (name: string) => ({
    name,
    createdAt: "2026-09-12T08:20:00Z",
    cancelledAt: null,
    phone: "+90 532 123 45 67",
    customer: { firstName: "Ayşe", lastName: "Yılmaz", defaultPhoneNumber: { phoneNumber: "+905321234567" } },
    shippingAddress: { firstName: "Ayşe Nur", lastName: "Yılmaz", phone: "0532 123 4567" },
    billingAddress: null,
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Maius Lavin Etek",
          variantTitle: "1–36/38 / Siyah",
          currentQuantity: 1,
          unfulfilledQuantity: 1,
          product: {
            legacyResourceId: "10094861484281",
            descriptionHtml: "<p><strong>🍂 SONBAHAR İNDİRİMİ:</strong> ...</p>",
            options: [{ optionValues: [{ name: "1–36/38" }, { name: "2–40/42" }] }, { optionValues: [{ name: "Siyah" }, { name: "Kırık Beyaz" }] }],
          },
          variant: { selectedOptions: [{ name: "Renk", value: "Siyah" }] },
        },
      ],
    },
    fulfillments: [
      { createdAt: "2026-09-13T08:00:00Z", status: "CANCELLED", displayStatus: null, deliveredAt: null, requiresShipping: true, trackingInfo: [], fulfillmentLineItems: { nodes: [] } },
      {
        createdAt: "2026-09-14T08:00:00Z",
        status: "SUCCESS",
        displayStatus: "IN_TRANSIT",
        deliveredAt: null,
        requiresShipping: true,
        trackingInfo: [{ company: "Yurtiçi Kargo", number: "123", url: "https://kargo.test/123" }],
        fulfillmentLineItems: { nodes: [{ lineItem: { id: "gid://shopify/LineItem/1" } }] },
      },
    ],
  });

  function fakeShopify() {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const api: ShopifyApi = {
      async graphql<T>(_store: unknown, query: string, variables?: Record<string, unknown>) {
        calls.push({ query, variables });
        if (query.includes("LinaCustomersByPhone")) return { customers: { nodes: [{ legacyResourceId: "555" }] } } as T;
        if (variables?.query === "name:1271") return { orders: { nodes: [gqlOrder("#MO-11271"), gqlOrder("#MO-1271")] } } as T;
        if (variables?.query === "customer_id:555") return { orders: { nodes: [gqlOrder("#MO-1271")] } } as T;
        return { orders: { nodes: [] } } as T;
      },
    };
    return { api, calls };
  }

  it("numarayla bulur (benzer numarayı karıştırmaz), telefonları tek biçime çevirir", async () => {
    const { api, calls } = fakeShopify();
    const source = shopifyOrderSource(api, {} as never);
    const found = await source.byName("MO-1271");
    expect(calls[0]!.variables).toEqual({ query: "name:1271", first: 5 });
    expect(found).toMatchObject({ name: "#MO-1271", phones: [CUSTOMER], names: ["Ayşe Yılmaz", "Ayşe Nur Yılmaz"] });
    expect(found!.items[0]).toMatchObject({ productId: "10094861484281", productOptionValues: ["1–36/38", "2–40/42", "Siyah", "Kırık Beyaz"] });
    // İptal edilen gönderim kargo bilgisi sayılmaz.
    expect(found!.shipments).toEqual([
      expect.objectContaining({ status: "IN_TRANSIT", carrier: "Yurtiçi Kargo", trackingUrl: "https://kargo.test/123", itemIds: ["gid://shopify/LineItem/1"] }),
    ]);
    expect(found!.items[0]!.currentDescription).toContain("🍂 SONBAHAR İNDİRİMİ:");
  });

  it("telefonlar mağazanın ülke koduna göre tamamlanır: ABD mağazasındaki yerel numara Türk numarasıyla eşleşmez", async () => {
    const usOrder = { ...gqlOrder("#1001"), phone: "555-123-4567", customer: null, shippingAddress: null };
    const api: ShopifyApi = {
      async graphql<T>() {
        return { orders: { nodes: [usOrder] } } as T;
      },
    };
    const found = await shopifyOrderSource(api, {} as never, { countryCode: "1" }).byName("1001");
    expect(found!.phones).toEqual(["5551234567"]);
    expect(belongsTo(found!, "905551234567")).toBe(false);
  });

  it("telefonla arama müşteri kaydı üzerinden yapılır; tutar ve adres hiç istenmez", async () => {
    const { api, calls } = fakeShopify();
    const orders = await shopifyOrderSource(api, {} as never).byPhone(CUSTOMER);
    expect(orders.map((o) => o.name)).toEqual(["#MO-1271"]);
    expect(calls.map((c) => c.variables?.query)).toEqual(["phone:+905321234567", "customer_id:555"]);
    const orderQuery = calls[1]!.query;
    for (const field of ["Price", "total", "address1", "city", "zip", "email"]) expect(orderQuery).not.toContain(field);
  });
});

describe("bildirim türü", () => {
  const f = (patch: Partial<OrderFindings>): OrderFindings => ({ ...newFindings(), ...patch });
  const verified = (unshipped: boolean) => new Map([["#MO-1", { unshipped, cancelled: false }]]);

  it("iptal isteği: kargoya verilmediyse önemli, kargodaysa kayıt", () => {
    expect(classifyFindings(f({ topics: ["cancel"], orders: verified(true) }))).toMatchObject({ kind: "cancel_request", important: true });
    expect(classifyFindings(f({ topics: ["cancel"], orders: verified(false) }))).toMatchObject({ kind: "order_question", important: false });
  });

  it("gecikme ve takip eksikliği önemli; şikayet her durumda önce gelir", () => {
    const delay = { kind: "delay" as const, orderName: "#MO-1", text: "Gecikme" };
    expect(classifyFindings(f({ topics: ["status"], orders: verified(true), issues: [delay] }))).toMatchObject({
      kind: "delay",
      important: true,
    });
    expect(classifyFindings(f({ topics: ["complaint", "status"], orders: verified(true), issues: [delay] }))).toMatchObject({
      kind: "complaint",
      kinds: ["complaint", "delay", "order_question"],
    });
  });

  it("doğrulanamayan siparişte yalnızca şikayet önemlidir", () => {
    expect(classifyFindings(f({ topics: ["cancel"], unverified: true }))).toMatchObject({ kind: "unverified", important: false });
    expect(classifyFindings(f({ topics: ["complaint"], unverified: true }))).toMatchObject({ kind: "complaint", important: true });
    expect(classifyFindings(f({ topics: ["return"], orders: verified(false) }))).toMatchObject({ kind: "return_request", important: false });
  });

  it("sipariş sistemine ulaşılamadıysa istek sessiz kalmaz", () => {
    expect(classifyFindings(f({ topics: ["cancel"], lookupFailed: true }))).toMatchObject({ kind: "lookup_failed", important: true });
  });

  it("numara verilmeden birden fazla sipariş listelendiyse sessiz sipariş sorusu kaydı", () => {
    expect(classifyFindings(f({ topics: ["cancel"] }))).toMatchObject({ kind: "order_question", kinds: ["order_question"], important: false });
  });
});

// ---------------------------------------------------------------------------
// Sahte Claude ile: sipariş uzmanı ve Lina'nın uçtan uca akışı

function message(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
const reply = (text: string) => message([{ type: "text", text, citations: null } as Anthropic.TextBlock], "end_turn");
const toolUse = (name: string, input: unknown) =>
  message([{ type: "tool_use", id: `toolu_${name}_${Math.random()}`, name, input } as Anthropic.ToolUseBlock], "tool_use");
const textOf = (content: Anthropic.MessageParam["content"]) =>
  typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join(" ");

/** Lina'ya, sipariş uzmanına, iade uzmanına ve bilgi uzmanına giden istekler. */
const calls = {
  lina: [] as Anthropic.MessageCreateParamsNonStreaming[],
  order: [] as Anthropic.MessageCreateParamsNonStreaming[],
  returns: [] as Anthropic.MessageCreateParamsNonStreaming[],
};
let orderAgentScript: ((params: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message) | null = null;
let returnsAgentScript: ((params: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message) | null = null;

/** Sahte Lina müşterinin yazdığı ad soyadı ve telefonu uzmana iletir. */
const identityOf = (text: string) => ({
  customer_name: /Zeynep Kaya|Ayşe Yılmaz/.exec(text)?.[0] ?? "",
  order_phone: /0\d{3} \d{3} \d{2} \d{2}/.exec(text)?.[0] ?? "",
});

const fakeLlm: Llm = {
  async create(params) {
    const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
    const last = params.messages.at(-1)!;
    if (system.includes("iade ve değişim uzmanısın")) {
      calls.returns.push(structuredClone(params));
      if (returnsAgentScript) return returnsAgentScript(params);
      return reply(`İADE UZMANI: ${textOf(last.content).split("\n").slice(0, 5).join(" | ")}`);
    }
    if (system.includes("sipariş uzmanısın")) {
      calls.order.push(structuredClone(params));
      if (orderAgentScript) return orderAgentScript(params);
      return reply(`UZMAN: ${textOf(last.content).split("\n").slice(0, 5).join(" | ")}`);
    }
    if (system.includes("bilgi uzmanısın")) return reply("İade süresi teslimden itibaren 14 gündür.");
    calls.lina.push(structuredClone(params));
    const blocks = last.content as Anthropic.ContentBlockParam[];
    if (blocks[0]?.type === "tool_result") return reply(`Lina: ${String((blocks[0] as Anthropic.ToolResultBlockParam).content)}`);
    const text = textOf(last.content);
    const number = /MO-\d+/.exec(text)?.[0] ?? "";
    if (text.includes("iade") || text.includes("hasarlı")) {
      const topic = text.includes("hasarlı") ? "damaged" : "return";
      return toolUse("ask_returns_agent", { topic, question: text, order_number: number, ...identityOf(text) });
    }
    const topic = text.includes("iptal") ? "cancel" : text.includes("gelmedi") ? "complaint" : "status";
    if (text.includes("sipariş") || number) return toolUse("ask_order_agent", { topic, question: text, order_number: number, ...identityOf(text) });
    return reply("Merhaba, nasıl yardımcı olabilirim?");
  },
};

const LAVIN_PRODUCT = {
  id: 10094861484281,
  title: "Maius Lavin Etek",
  handle: "lavin-etek",
  body_html: `<p>${PREORDER_SIYAH}</p><p>${CAMPAIGN}</p><p>Poplin kumaştan üretilmektedir.</p>`,
  tags: ["Ön Sipariş", "Sonbahar İndirimi"],
  variants: [{ id: 1, title: "1–36/38 / Siyah", price: "2099.00", compare_at_price: "3299.00" }],
} as StorefrontProduct;
const RIVA_PRODUCT = {
  id: 10246378717433,
  title: "Maius Riva Takım",
  handle: "riva-takim",
  body_html: `<p>${CAMPAIGN}</p><p>Akıcı dokulu kumaştan iki parçalı takım.</p>`,
  tags: ["Sonbahar İndirimi"],
  variants: [{ id: 2, title: "2–40/42 / Vizon", price: "2160.00", compare_at_price: "3600.00" }],
} as StorefrontProduct;

describe("deneme siparişleri", () => {
  const source = demoOrderSource(() => CUSTOMER, () => NOW);
  const sheet = async (no: string) => buildOrderSheet((await source.byName(no))!, new Map(), NOW, TZ).text;

  it("her durum için bir sipariş var; kampanya ve ön sipariş yazıları siparişin içinde", async () => {
    expect(await sheet("MO-9002")).toContain("SONBAHAR İNDİRİMİ");
    expect(await sheet("MO-9001")).toContain("GECİKME");
    expect(await sheet("MO-9006")).toContain("Hazırlanıyor");
    expect(await sheet("MO-9007")).toContain("https://www.yurticikargo.com");
    expect(await sheet("MO-9008")).toContain("10 Ekim");
    expect(await sheet("MO-9008")).not.toContain("GECİKME");
    expect(await sheet("MO-9009")).toContain("İptal edildi (19 Eylül 2026)");
    expect(await sheet("MO-9010")).toContain("Kısmen kargoya verildi");
    expect(await sheet("MO-9011")).toContain("Teslim edildi (19 Ağustos 2026)");
  });

  it("tarihler bugüne göre kurulur: senaryolar zamanla bozulmaz", async () => {
    const later = demoOrderSource(() => CUSTOMER, () => new Date("2026-12-01T09:00:00Z"));
    const order = (await later.byName("MO-9003"))!;
    expect(order.shipments[0]!.deliveredAt!.toISOString().slice(0, 10)).toBe("2026-11-27");
  });

  it("iade talepleri: MO-9012 inceleniyor, MO-9013 50 gün önce depoya ulaştı ama para iadesi yok", async () => {
    const returns = demoReturnsProvider(() => NOW);
    const [open] = await returns.requestsFor("#MO-9012");
    expect(open).toMatchObject({ status: "RECEIVED", createdAt: "2026-09-20" });
    const [late] = await returns.requestsFor("#MO-9013");
    expect(late!.status).toBe("APPROVED");
    expect(late!.history.find((h) => h.status === "RECEIVED")!.at).toBe("2026-08-09");
    expect(await returns.requestsFor("#MO-9003")).toEqual([]);
  });
});

describe("sipariş uzmanı", () => {
  let database: Database;
  let tenant: Tenant;

  beforeAll(async () => {
    database = await openDatabase({});
    [tenant] = (await database.db.insert(tenants).values({ slug: "maius", name: "MAIUS" }).returning()) as [Tenant];
    await recordSnapshot(database.db, tenant.id, "product", [productSnapshot(LAVIN_PRODUCT), productSnapshot(RIVA_PRODUCT)], new Date("2026-09-10T00:00:00Z"));
  });
  afterAll(() => database.close());
  beforeEach(() => {
    calls.order.length = 0;
    orderAgentScript = null;
  });

  const ctx = () => ({ db: database.db, llm: fakeLlm, model: "claude-sonnet-5", tenantId: tenant.id, conversationId: null });
  const deps = () => ({ source: demoOrderSource(() => CUSTOMER, () => NOW), waId: CUSTOMER, timeZone: TZ, now: NOW, returns: null });

  it("sipariş önceden okunur: kart kampanya ve gecikmeyle uzmana gider", async () => {
    const findings = newFindings();
    await askOrderAgent(ctx(), tenant, deps(), { topic: "status", question: "Siparişim nerede?", orderNumber: "MO-9001" }, findings);
    const sent = textOf(calls.order[0]!.messages[0]!.content);
    expect(sent).toContain("SİPARİŞ #MO-9001 (doğrulandı");
    expect(sent).toContain("GECİKME");
    expect(sent).toContain(`• ${CAMPAIGN}`);
    expect([...findings.orders.keys()]).toEqual(["#MO-9001"]);
    expect(findings.issues.map((i) => i.kind)).toEqual(["delay"]);
  });

  it("başka numaranın siparişi: hiçbir bilgi gitmez, var olup olmadığı söylenmez; ad soyad istenir", async () => {
    const findings = newFindings();
    await askOrderAgent(ctx(), tenant, deps(), { topic: "status", question: "Siparişim?", orderNumber: "MO-9005" }, findings);
    const sent = textOf(calls.order[0]!.messages[0]!.content);
    expect(sent).toContain("DOĞRULAMA GEREKLİ");
    expect(sent).toContain("siparişte kayıtlı adını ve soyadını iste");
    expect(sent).not.toContain("Top Takım");
    expect(findings).toMatchObject({ unverified: true });
    expect(findings.orders.size).toBe(0);
  });

  it("numara tutmazsa sipariş no + siparişteki ad soyad birlikte doğrular; yanlış ad soyad bilgi vermez", async () => {
    const ask = async (name: string) => {
      calls.order.length = 0;
      const findings = newFindings();
      const identity = { name, orderPhone: "" };
      await askOrderAgent(ctx(), tenant, deps(), { topic: "status", question: "?", orderNumber: "MO-9005", identity }, findings);
      return { sent: textOf(calls.order[0]!.messages[0]!.content), findings };
    };
    const right = await ask("zeynep KAYA");
    expect(right.sent).toContain("Top Takım");
    expect([...right.findings.orders.keys()]).toEqual(["#MO-9005"]);
    // Uzman ve ekip, siparişin numarayla değil ad soyadla doğrulandığını görür.
    expect(right.sent).toContain("doğrulandı: müşterinin yazdığı ad soyad siparişle eşleşiyor");
    expect(right.findings.orders.get("#MO-9005")).toMatchObject({ byName: true });
    // Uzun isim listesi doğrulamaz.
    const stuffed = await ask("Ayşe Fatma Zeynep Elif Merve Yılmaz Kaya Demir Şahin Çelik");
    expect(stuffed.sent).toContain("DOĞRULANAMADI");
    expect(stuffed.findings.orders.size).toBe(0);
    const wrong = await ask("Ayşe Yılmaz");
    expect(wrong.sent).toContain("DOĞRULANAMADI");
    expect(wrong.sent).not.toContain("Top Takım");
    // Yalnızca ad yetmez.
    expect((await ask("Zeynep")).sent).toContain("DOĞRULANAMADI");
  });

  it("deneme sınırı aşıldıysa ad soyadla doğrulama kapalıdır; WhatsApp numarası eşleşen sipariş yine görünür", async () => {
    const ask = async (orderNumber: string | null, identity: { name: string; orderPhone: string }, locked: boolean) => {
      calls.order.length = 0;
      const findings = newFindings();
      await askOrderAgent(ctx(), tenant, { ...deps(), identityLocked: locked }, { topic: "status", question: "?", orderNumber, identity }, findings);
      return { sent: textOf(calls.order[0]!.messages[0]!.content), findings };
    };
    // Yanlış ad soyad denemesi sayılır; yalnızca numara yazıp ad soyad istenmesi sayılmaz.
    expect((await ask("MO-9005", { name: "Ayşe Yılmaz", orderPhone: "" }, false)).findings.failedIdentity).toBe(true);
    expect((await ask("MO-9005", { name: "", orderPhone: "" }, false)).findings.failedIdentity).toBeUndefined();

    // Kilitliyken doğru ad soyad da açmaz; yeniden bilgi istenmez.
    const locked = await ask("MO-9005", { name: "Zeynep Kaya", orderPhone: "" }, true);
    expect(locked.sent).toContain("DOĞRULAMA KİLİTLİ");
    expect(locked.sent).not.toContain("Top Takım");
    expect(locked.findings).toMatchObject({ unverified: true, identityLocked: true });
    expect(locked.findings.orders.size).toBe(0);
    const byPhone = await ask(null, { name: "Zeynep Kaya", orderPhone: "0555 999 99 99" }, true);
    expect(byPhone.sent).not.toContain("Top Takım");
    // Müşterinin kendi numarasına kayıtlı sipariş kilitten etkilenmez.
    const own = await ask("MO-9001", { name: "", orderPhone: "" }, true);
    expect(own.sent).toContain("SİPARİŞ #MO-9001 (doğrulandı: müşterinin WhatsApp numarasıyla eşleşiyor)");
  });

  it("sipariş numarasını bilmeyen: siparişte kayıtlı telefon + ad soyadla bulunur", async () => {
    const stranger = { ...deps(), waId: "905000000000" };
    const ask = async (identity?: { name: string; orderPhone: string }) => {
      calls.order.length = 0;
      const findings = newFindings();
      await askOrderAgent(ctx(), tenant, stranger, { topic: "status", question: "?", orderNumber: null, identity }, findings);
      return { sent: textOf(calls.order[0]!.messages[0]!.content), findings };
    };
    const none = await ask();
    expect(none.sent).toContain("sipariş numarasını bilmiyorsa siparişte kayıtlı telefon numarasını");
    const found = await ask({ name: "Zeynep Kaya", orderPhone: "0555 999 99 99" });
    expect(found.sent).toContain("Top Takım");
    expect([...found.findings.orders.keys()]).toEqual(["#MO-9005"]);
    expect(found.findings.orders.get("#MO-9005")).toMatchObject({ byName: true });
    const wrongName = await ask({ name: "Ayşe Yılmaz", orderPhone: "0555 999 99 99" });
    expect(wrongName.sent).toContain("DOĞRULANAMADI");
    expect(wrongName.findings.orders.size).toBe(0);
  });

  it("numara verilmezse müşterinin siparişleri listelenir", async () => {
    const findings = newFindings();
    await askOrderAgent(ctx(), tenant, deps(), { topic: "status", question: "Siparişim ne durumda?", orderNumber: null }, findings);
    const sent = textOf(calls.order[0]!.messages[0]!.content);
    expect(sent).toContain("#MO-9004 · 24 Eylül 2026");
    // En yeni 5 sipariş listelenir.
    expect(sent).toContain("#MO-9006 · 27 Eylül 2026 · Hazırlanıyor");
    expect(sent).not.toContain("#MO-9001");
    expect(sent).not.toContain("#MO-9005");
  });

  it("telefonsuz gelen sipariş uyarı yazar: Shopify telefon izni eksik olabilir", async () => {
    const warnings: string[] = [];
    const noPhones = { ...order(), phones: [] };
    const source = { byName: async () => noPhones, byPhone: async () => [] };
    const findings = newFindings();
    await askOrderAgent(
      { ...ctx(), log: { warn: (m: string) => warnings.push(m) } },
      tenant,
      { ...deps(), source },
      { topic: "status", question: "?", orderNumber: "MO-1271" },
      findings,
    );
    expect(findings.unverified).toBe(true);
    expect(warnings).toEqual([expect.stringContaining('"Protected customer data" (telefon) izni verilmemiş olabilir')]);
  });

  it("report_delay yalnızca doğrulanmış siparişe uygulanır", async () => {
    let step = 0;
    orderAgentScript = (params) => {
      step++;
      if (step === 1) return toolUse("report_delay", { order_number: "MO-9005", product: "Top Takım", planned_date: "1 Eylül 2026" });
      if (step === 2) return toolUse("report_delay", { order_number: "MO-9002", product: "Riva Takım", planned_date: "20 Eylül 2026" });
      const results = params.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
      return reply(results.join(" "));
    };
    const findings = newFindings();
    const answer = await askOrderAgent(ctx(), tenant, deps(), { topic: "status", question: "?", orderNumber: "MO-9002" }, findings);
    expect(answer).toContain("Bu sipariş doğrulanmadı");
    expect(findings.issues).toEqual([{ kind: "delay", orderName: "#MO-9002", text: "Gecikme: Riva Takım, planlanan kargo 20 Eylül 2026" }]);
  });
});

describe("konuşma akışı: sipariş sorusu devredilmez, ekibe bildirim düşer", () => {
  const APP_SECRET = "test-secret";
  const PHONE_NUMBER_ID = "111222333";
  const OTHER_NUMBER_ID = "999888777";
  const MASTER_KEY = randomBytes(32).toString("base64");
  const sent: string[] = [];
  const events: PanelEvent[] = [];
  const scheduledMemory: string[] = [];
  let database: Database;
  let server: Server;
  let baseUrl: string;
  let queue: ReturnType<typeof createApp>["queue"];
  let scheduler: ReturnType<typeof createApp>["scheduler"];
  let tenantId: string;
  let seq = 0;

  let failSend = false;
  const fakeWa: WhatsAppSender = {
    async sendText({ text }) {
      if (failSend) throw new Error("WhatsApp 500");
      sent.push(text);
      return [`wamid.out.${sent.length}`];
    },
    async markReadAndTyping() {},
    async downloadMedia() {
      return { data: Buffer.from("x"), mimeType: "image/jpeg" };
    },
  };

  beforeAll(async () => {
    database = await openDatabase({});
    const bus = new EventBus();
    const [maius, other] = await database.db
      .insert(tenants)
      .values([
        { slug: "maius", name: "MAIUS", settings: { returnsFormUrl: "https://iade.betulsaday.com" } },
        { slug: "shopifysiz", name: "Shopifysiz Mağaza" },
      ])
      .returning();
    tenantId = maius!.id;
    bus.subscribe(tenantId, (e) => events.push(e));
    await database.db.insert(whatsappAccounts).values([
      { tenantId, phoneNumberId: PHONE_NUMBER_ID, accessTokenEnc: encryptSecret("t1", MASTER_KEY) },
      { tenantId: other!.id, phoneNumberId: OTHER_NUMBER_ID, accessTokenEnc: encryptSecret("t2", MASTER_KEY) },
    ]);
    await recordSnapshot(database.db, tenantId, "product", [productSnapshot(LAVIN_PRODUCT), productSnapshot(RIVA_PRODUCT)], new Date("2026-09-10T00:00:00Z"));

    const deps: Deps = {
      db: database.db,
      llm: fakeLlm,
      wa: fakeWa,
      model: "claude-sonnet-5",
      masterKey: MASTER_KEY,
      historyLimit: 20,
      timeZone: TZ,
      log: { info() {}, warn() {}, error() {} },
      now: () => NOW,
      events: bus,
      replyDelayOverrideMs: 0,
      // Müşteri kartı güncellemesi sıraya alınır (burada çalıştırılmaz; core/memory testlerinde).
      memory: { model: "haiku", schedule: (customerId) => void scheduledMemory.push(customerId) },
      // Yalnızca MAIUS'ta sipariş kaynağı var (Shopify bağlı). MO-9999 sorgusu Shopify hatası verir.
      orderSourceFor: async (id) => {
        if (id !== tenantId) return null;
        const demo = demoOrderSource(() => CUSTOMER, () => NOW);
        return {
          byName: async (n: string) => {
            if (n.includes("9999")) throw new Error("Shopify GraphQL hatası (503)");
            return demo.byName(n);
          },
          byPhone: demo.byPhone,
        };
      },
    };
    const created = createApp({ WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: "v" }, deps);
    queue = created.queue;
    scheduler = created.scheduler;
    server = created.app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await database.close();
  });

  beforeEach(async () => {
    sent.length = 0;
    events.length = 0;
    calls.lina.length = 0;
    calls.order.length = 0;
    calls.returns.length = 0;
    orderAgentScript = null;
    returnsAgentScript = null;
    await database.db.delete(customers);
  });

  async function say(body: string, phoneNumberId = PHONE_NUMBER_ID) {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: phoneNumberId },
                contacts: [{ wa_id: CUSTOMER, profile: { name: "Ayşe" } }],
                messages: [{ from: CUSTOMER, id: `wamid.in.${++seq}`, timestamp: "0", type: "text", text: { body } }],
              },
            },
          ],
        },
      ],
    });
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
    const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      body: raw,
    });
    expect(res.status).toBe(200);
    await queue.idle();
    await scheduler.idle();
  }

  const allNotifications = () => database.db.select().from(notifications);

  it("gecikmiş ön sipariş: Lina cevaplar, önemli bildirim düşer, konuşma devredilmez", async () => {
    scheduledMemory.length = 0;
    await say("MO-9001 numaralı siparişim nerede?");
    expect(sent).toHaveLength(1);
    // Cevaptan sonra müşteri kartı güncellemesi sıraya girdi.
    expect(scheduledMemory).toHaveLength(1);
    expect(sent[0]).toContain("Lina: UZMAN: Konu: sipariş durumu, kargo, ön sipariş");

    const [n] = await allNotifications();
    expect(n).toMatchObject({ kind: "delay", important: true, orderNames: ["#MO-9001"], status: "open" });
    expect(n!.details.issues).toEqual(["Gecikme: Maius Lavin Etek (1–36/38 / Siyah), planlanan kargo 25 Eylül 2026"]);
    expect(n!.question).toBe("MO-9001 numaralı siparişim nerede?");
    expect(n!.answer).toBe(sent[0]);
    expect(events).toContainEqual({ type: "notification", conversationId: n!.conversationId, important: true });

    expect(await database.db.select().from(handoffs)).toHaveLength(0);
    const [c] = await database.db.select().from(conversations).where(eq(conversations.id, n!.conversationId));
    expect(c!.status).toBe("bot");
  });

  it("iptal isteği: kargoya verilmediyse önemli, verildiyse kayıt", async () => {
    await say("MO-9001 siparişimi iptal etmek istiyorum");
    await say("MO-9002 siparişimi de iptal edin");
    const rows = (await allNotifications()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows.map((r) => [r.orderNames[0], r.kind, r.important])).toEqual([
      ["#MO-9001", "cancel_request", true],
      ["#MO-9002", "order_question", false],
    ]);
  });

  it("sipariş sistemine ulaşılamazsa iptal isteği sessiz kalmaz: önemli bildirim", async () => {
    await say("MO-9999 siparişimi iptal edin");
    const [n] = await allNotifications();
    expect(n).toMatchObject({ kind: "lookup_failed", important: true, orderNames: [] });
  });

  it("cevap WhatsApp'a gönderilemezse bildirim önemli olur ve bu yazılır", async () => {
    failSend = true;
    try {
      await say("MO-9002 kargom nerede?");
    } finally {
      failSend = false;
    }
    const [n] = await allNotifications();
    expect(n).toMatchObject({ kind: "order_question", important: true, orderNames: ["#MO-9002"] });
    expect(n!.details.replyFailed).toBe(true);
    expect(n!.details.issues![0]).toContain("WhatsApp'a gönderilemedi");
  });

  it("başka numaranın siparişi: bilgi verilmez, ad soyad istenir; ad soyad tutunca bakılır", async () => {
    await say("MO-9005 siparişim ne durumda?");
    expect(sent[0]).toContain("DOĞRULAMA GEREKLİ");
    expect(sent[0]).not.toContain("Top Takım");
    const [n] = await allNotifications();
    expect(n).toMatchObject({ kind: "unverified", important: false, orderNames: [] });

    await say("MO-9005 siparişim, adım Zeynep Kaya");
    expect(sent[1]).not.toContain("DOĞRULAMA");
    const latest = (await allNotifications()).at(-1);
    expect(latest).toMatchObject({ kind: "order_question", orderNames: ["#MO-9005"] });
  });

  it("Lina'nın talimatı: müşteri hizmetleri yaklaşımı, iade uzmanı, iade formu; devir aracı sipariş için kullanılmaz", async () => {
    await say("sipariş durumumu öğrenebilir miyim?");
    const params = calls.lina[0]!;
    const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
    // Lina'nın geçmişi de önbelleğe alınır (araç döngüsündeki ikinci çağrı ucuz okur); uzmanlarınki değil.
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    expect(system).toContain("ask_order_agent");
    expect(system).toContain("ask_returns_agent");
    expect(system).toContain("Mağazanın iade ve değişim formu: https://iade.betulsaday.com");
    // Önce anla ve sakinleştir; kişiye iletildiği söylenmez, "işleme alındı" cevabın sonunda, zaman sözü yok.
    expect(system).toContain("*Müşteri hizmetleri yaklaşımı*");
    expect(system).toContain('"Talebiniz işleme alındı. Başka bir konuda yardımcı olabileceğim bir şey var mı?"');
    expect(system).toContain("Müşteriye bir kişiye, temsilciye ya da arkadaşına ilettiğini veya devrettiğini söyleme");
    // Birim adı serbest, ama yalnızca talep gerçekten ekibe bildirildiyse.
    expect(system).toContain('Talebin ilgili birime iletildiğini söylemek serbest ("iade birimine ilettim" gibi), ama yalnızca talep gerçekten ekibe bildirildiyse');
    expect(system).toContain('"İptal talebiniz işleme alındı."');
    expect(system).toContain("ne zaman ya da nasıl sonuçlanacağını söyleme");
    expect(system).not.toContain("arkadaşımıza ilettim");
    // Tutarsızlık müşteriye anlatılmaz; bilgi gerekiyorsa "kontrol ediyorum".
    expect(system).toContain("tutarsızlıktan bahsetme");
    expect(system).toContain('"Hemen kontrol ediyorum, kısa süre içinde size buradan bilgi vereceğim."');
    expect(system).not.toContain("Ekibimize ilettim");
    expect(system).not.toContain("Bilgiler tamamlanınca devret");
    // Başvuru yolu çelişkisinde (form mu, e-posta mı) mağazanın iade formu geçerli; rakam çelişkisinde devir.
    expect(system).toContain("İstisna: çelişki yalnızca iade, değişim ya da hasarlı ürün başvurusunun nereden yapılacağıyla ilgiliyse");
    const tool = (name: string) => params.tools!.find((t) => "name" in t && t.name === name) as Anthropic.Tool;
    expect(tool("handoff_to_human").description).toContain("sipariş, iade, iptal, değişiklik ve şikayet için de değil");
    // Bilmediği bilgi devredilmez, arka planda ekibe sorulur.
    expect(tool("ask_team").description).toContain("arka planda mağaza ekibine sorar");
    expect(system).toContain("ask_team ile ekibe sor (konuşmayı devretme)");
    // İade, değişim ve hasarlı ürün sipariş uzmanına değil iade uzmanına gider.
    const orderTopics = (tool("ask_order_agent").input_schema.properties as Record<string, { enum?: string[] }>).topic!.enum;
    expect(orderTopics).not.toContain("return");
    expect(orderTopics).not.toContain("return_status");
  });

  it("iade isteği: iade uzmanı siparişin kartını ve iade formunu görür; kendi çözebildiğini iletmez (sessiz kayıt)", async () => {
    await say("MO-9002 siparişimi iade etmek istiyorum");
    expect(calls.order).toHaveLength(0);
    const request = calls.returns[0]!;
    expect(request.cache_control).toBeUndefined();
    expect((request.system as Anthropic.TextBlockParam[])[0]!.text).toContain("Mağaza notları ve mağazanın öğrettikleri");
    const card = textOf(request.messages[0]!.content);
    expect(card).toContain("Konu: iade ya da değişim isteği, iade koşulları");
    expect(card).toContain("#MO-9002");
    expect(card).toContain("SONBAHAR İNDİRİMİ");
    const system = (request.system as Anthropic.TextBlockParam[])[0]!.text;
    expect(system).toContain("Mağazanın iade ve değişim formu: https://iade.betulsaday.com");
    expect(sent[0]).toContain("İADE UZMANI:");
    const [n] = await allNotifications();
    expect(n).toMatchObject({ kind: "return_request", important: false, orderNames: ["#MO-9002"] });
    expect(await database.db.select().from(handoffs)).toHaveLength(0);
  });

  it("kural dışı iade isteği: iade uzmanı ekibe iletir, önemli bildirim düşer, konuşma devredilmez", async () => {
    let step = 0;
    returnsAgentScript = () =>
      step++ === 0
        ? toolUse("forward_to_team", { order_number: "MO-9002", reason: "Kampanyalı ürünü beden olmadı diye iade etmek istiyor." })
        : reply("EKİBE: iletildi");
    await say("MO-9002 kampanyalı ama iade etmek istiyorum");
    const [n] = await allNotifications();
    expect(n).toMatchObject({ kind: "return_review", important: true, orderNames: ["#MO-9002"] });
    expect(n!.details.issues).toEqual(["İade: Kampanyalı ürünü beden olmadı diye iade etmek istiyor."]);
    expect(await database.db.select().from(handoffs)).toHaveLength(0);
  });

  it("hasarlı ürün iade uzmanına gider ve her durumda önemlidir", async () => {
    await say("MO-9003 hasarlı geldi");
    expect(textOf(calls.returns[0]!.messages[0]!.content)).toContain("Konu: hasarlı, hatalı ya da yanlış ürün");
    const [n] = await allNotifications();
    expect(n).toMatchObject({ kind: "complaint", important: true });
  });

  it("Shopify'ı bağlı olmayan mağaza: sipariş uzmanı yok; iade uzmanı politikalarla çalışır, iletilecek konu devredilir", async () => {
    await say("merhaba", OTHER_NUMBER_ID);
    const params = calls.lina[0]!;
    const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
    expect(system).toContain('Uzman ekibe "iletilmeli" dediyse');
    expect(system).not.toContain("İstisna: çelişki");
    expect(params.tools!.some((t) => "name" in t && t.name === "ask_order_agent")).toBe(false);
    expect(params.tools!.some((t) => "name" in t && t.name === "ask_returns_agent")).toBe(true);

    await say("iade etmek istiyorum", OTHER_NUMBER_ID);
    const request = calls.returns[0]!;
    expect(textOf(request.messages[0]!.content)).toContain("Sipariş sistemi bağlı değil");
    expect(request.tools!.map((t) => ("name" in t ? t.name : ""))).not.toContain("forward_to_team");
    expect((request.system as Anthropic.TextBlockParam[])[0]!.text).toContain('EKİBE satırına "iletilmeli"');
    expect(await allNotifications()).toHaveLength(0);
  });
});
