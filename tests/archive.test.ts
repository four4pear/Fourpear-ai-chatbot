import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../src/db/client.js";
import { knowledgeDocs, shopifyStores, tenants } from "../src/db/schema.js";
import { campaignDigest, currentTexts, recordSnapshot, textAt } from "../src/archive/archive.js";
import {
  extractSiteTexts,
  fetchStorefrontProducts,
  productSnapshot,
  siteTextsOf,
  storefrontBase,
  type StorefrontProduct,
} from "../src/archive/storefront.js";
import { archiveAllTenants, archiveTenant } from "../src/archive/sync.js";

const PREORDER =
  "<p><strong>🕒 ÖN SİPARİŞ:</strong> <strong>Siyah</strong> renk ön sipariş kapsamındadır; siparişler <strong>25 Eylül</strong> tarihinde kargoya teslim edilir. Kırık Beyaz renk stoktan çıkmaktadır.</p>";
const CAMPAIGN =
  "<p><strong>🍂 SONBAHAR İNDİRİMİ:</strong> Bu ürün 30 Eylül'e kadar indirimli fiyatla satışa sunulmaktadır. Sonbahar İndirimi kapsamında indirimli ürünlerde 14 günlük iade ve değişim uygulanmamaktadır; yalnızca hasarlı, hatalı veya yanlış gönderilen ürünlerde değişim veya iade yapılır.</p>";
const BODY = "<p>Poplin kumaştan üretilmektedir. Etek boy kemer dahil 95-97 cm dir.</p>";

/** MAIUS vitrinindeki biçimde bir ürün (products.json). */
function lavin(opts: { body?: string; price?: string; compareAt?: string | null; available?: boolean; id?: number } = {}) {
  const variant = (id: number, title: string) => ({
    id,
    title,
    price: opts.price ?? "2099.00",
    compare_at_price: opts.compareAt === undefined ? "3299.00" : opts.compareAt,
    available: opts.available ?? true,
  });
  return {
    id: opts.id ?? 10094861484281,
    title: "Maius Lavin Etek",
    handle: "lavin-etek",
    body_html: opts.body ?? PREORDER + CAMPAIGN + BODY,
    tags: ["Ön Sipariş", "Sonbahar İndirimi"],
    variants: [variant(48537728516345, "2–40/42 / Kırık Beyaz"), variant(48537728483577, "1–36/38 / Kırık Beyaz")],
  } as StorefrontProduct;
}

const HOME = `<html><body>
<aside id="shopify-section-sections--27793339187449__announcement_bar_qgNBHb" class="shopify-section shopify-section-group-header-group shopify-section--announcement-bar"><div class="announcement-bar"><announcement-bar-carousel><p class="prose heading">3.000 TL ve üzeri siparişlerde ücretsiz kargo</p></announcement-bar-carousel></div></aside>
<header id="shopify-section-sections--27793339187449__header" class="shopify-section shopify-section-group-header-group shopify-section--header"><a>YENİ GELENLER</a> <a>Elbiseler</a></header>
<section id="shopify-section-template--27793339711737__slideshow" class="shopify-section shopify-section--slideshow"><img src="a.jpg"></section>
<section id="shopify-section-template--27793339711737__countdown_sonbahar" class="shopify-section shopify-section--countdown"><div class="countdown"><p class="h6">SON GÜNLER</p><h2>SONBAHAR İNDİRİMİ</h2><p>Seçili parçalarda sezon fiyatları 30 Eylül’e kadar geçerli.</p><p>00 Gün : 00 Saat : 00 Dk : 00 Sn</p><script>var kalan = 1;</script></div></section>
<section id="shopify-section-template--27793339711737__featured-collections-1" class="shopify-section shopify-section--featured-collections"><p>%36 İNDİRİM Lavin Etek İndirimli fiyat 2,099.00TL</p></section>
<div id="shopify-section-template--123__rich_text_AbC123" class="shopify-section"><div class="rich-text"><h2>Kargo bedava</h2><p>Bu hafta sonu tüm siparişlerde.</p></div></div>
<footer id="shopify-section-sections--1__footer" class="shopify-section shopify-section--footer"><p>MAIUS Minimal şıklığın güçlü yorumu.</p></footer>
</body></html>`;

/** Sahte vitrin: adres → (durum, gövde). Yapılan istekleri kaydeder. */
function fakeStorefront(routes: Record<string, [number, string] | (() => [number, string])>) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    const route = routes[url];
    const [status, body] = typeof route === "function" ? route() : (route ?? [404, "yok"]);
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const productsPage = (products: StorefrontProduct[]) => JSON.stringify({ products });

let database: Database;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  database = await openDatabase({});
  const [t, o] = await database.db
    .insert(tenants)
    .values([
      { slug: "maius", name: "MAIUS", domain: "maiusonline.com" },
      { slug: "diger", name: "Diğer" },
    ])
    .returning();
  tenantId = t!.id;
  otherTenantId = o!.id;
});
afterAll(() => database.close());

describe("vitrin ürünü → arşiv kaydı", () => {
  it("açıklamadaki ön sipariş ve kampanya satırları düz metin olarak, kısaltılmadan gelir", () => {
    const s = productSnapshot(lavin());
    expect(s.ref).toBe("10094861484281");
    const [first, second] = s.content.split("\n");
    expect(first).toBe(
      "🕒 ÖN SİPARİŞ: Siyah renk ön sipariş kapsamındadır; siparişler 25 Eylül tarihinde kargoya teslim edilir. Kırık Beyaz renk stoktan çıkmaktadır.",
    );
    expect(second).toBe(
      "🍂 SONBAHAR İNDİRİMİ: Bu ürün 30 Eylül'e kadar indirimli fiyatla satışa sunulmaktadır. Sonbahar İndirimi kapsamında indirimli ürünlerde 14 günlük iade ve değişim uygulanmamaktadır; yalnızca hasarlı, hatalı veya yanlış gönderilen ürünlerde değişim veya iade yapılır.",
    );
    expect(s.data.tags).toEqual(["Sonbahar İndirimi", "Ön Sipariş"]);
    // Stok durumu alınmaz; varyantlar sıralı.
    expect(s.data.variants).toEqual([
      { id: "48537728483577", title: "1–36/38 / Kırık Beyaz", price: "2099.00", compareAtPrice: "3299.00" },
      { id: "48537728516345", title: "2–40/42 / Kırık Beyaz", price: "2099.00", compareAtPrice: "3299.00" },
    ]);
  });
});

describe("site yazıları", () => {
  it("üst bant, geri sayım ve metin bölümlerini alır; menü, ürün listesi ve alt bilgiyi almaz", () => {
    const texts = extractSiteTexts(HOME);
    expect(texts.map((t) => [t.ref, t.title])).toEqual([
      ["announcement_bar_qgNBHb", "announcement-bar"],
      ["countdown_sonbahar", "countdown"],
      ["rich_text_AbC123", "rich_text"],
    ]);
    expect(texts[0]!.content).toBe("3.000 TL ve üzeri siparişlerde ücretsiz kargo");
    expect(texts[1]!.content).toContain("SONBAHAR İNDİRİMİ");
    expect(texts[1]!.content).toContain("30 Eylül’e kadar geçerli");
    expect(texts[1]!.content).not.toContain("kalan");
    // Geri sayımın boş kalıbı arşive girmez (her gün aynı olsa da gürültüdür).
    expect(texts[1]!.content).not.toContain("00 Gün");
  });

  it("güncel kampanya özeti: site yazıları ve en az iki üründe geçen koşul satırları", () => {
    const campaign = "🍂 SONBAHAR İNDİRİMİ: Bu ürün 30 Eylül'e kadar indirimli fiyatla satışa sunulmaktadır.";
    const digest = campaignDigest(
      [{ content: "3.000 TL ve üzeri siparişlerde ücretsiz kargo" }],
      [
        { content: `${campaign}\nPoplin kumaş.` },
        { content: `${campaign}\nKeten kumaş.` },
        { content: "🕒 ÖN SİPARİŞ: Yalnızca bu üründe geçen satır." },
      ],
    );
    expect(digest).toBe(
      [
        "Sitenin görünen yazıları (üst bant, ana sayfa):",
        "- 3.000 TL ve üzeri siparişlerde ücretsiz kargo",
        "",
        "Ürün açıklamalarında ortak geçen kampanya ve koşul yazıları (bugünkü haliyle):",
        `- ${campaign} (2 üründe)`,
      ].join("\n"),
    );
    expect(campaignDigest([], [{ content: "Poplin kumaş." }])).toBeNull();
  });
});

describe("kampanya arşivi", () => {
  // 28 Eylül: kampanya yazısı var · 29 Eylül: aynı · 1 Ekim: yazı silindi, fiyat normale döndü · 5 Ekim: ürün kalktı
  const T1 = new Date("2026-09-28T10:51:00Z");
  const T2 = new Date("2026-09-29T09:00:00Z");
  const T3 = new Date("2026-10-01T09:00:00Z");
  const T4 = new Date("2026-10-05T09:00:00Z");
  const ref = "10094861484281";

  it("değişmeyen yazı yeni sürüm açmaz; değişen yazının eskisi kalır; kalkan ürün kapanır", async () => {
    const { db } = database;
    expect(await recordSnapshot(db, tenantId, "product", [productSnapshot(lavin())], T1)).toEqual({
      added: 1, changed: 0, unchanged: 0, ended: 0,
    });
    // Sadece stok durumu değişti: aynı sürüm, son görülme ilerler.
    expect(await recordSnapshot(db, tenantId, "product", [productSnapshot(lavin({ available: false }))], T2)).toEqual({
      added: 0, changed: 0, unchanged: 1, ended: 0,
    });
    const afterCampaign = lavin({ body: BODY, price: "3299.00", compareAt: null });
    expect(await recordSnapshot(db, tenantId, "product", [productSnapshot(afterCampaign)], T3)).toEqual({
      added: 0, changed: 1, unchanged: 0, ended: 0,
    });
    // Çekme hatası (boş liste) hiçbir şeyi kapatmaz.
    expect((await recordSnapshot(db, tenantId, "product", [], T3)).ended).toBe(0);
    expect(await currentTexts(db, tenantId, "product")).toHaveLength(1);
    // Başka ürün göründü, Lavin Etek artık yok: sürümü kapanır ama silinmez.
    const other = productSnapshot(lavin({ id: 1, body: BODY }));
    expect(await recordSnapshot(db, tenantId, "product", [other], T4)).toEqual({ added: 1, changed: 0, unchanged: 0, ended: 1 });
  });

  it("Eylül'de verilen siparişte, yazı Ekim'de silinmiş olsa da kampanya yazısı bulunur", async () => {
    const { db } = database;
    const sept29 = await textAt(db, tenantId, "product", ref, new Date("2026-09-29T08:00:00Z"));
    expect(sept29).toMatchObject({ confirmed: true, beforeArchive: false });
    expect(sept29!.version.content).toContain("🍂 SONBAHAR İNDİRİMİ");
    expect(sept29!.version.endedAt).toEqual(T3);

    // Son görülmeden (29 Eylül) sonra, değişiklikten (1 Ekim) önce: bilinen son yazı, kesin değil.
    const sept30 = await textAt(db, tenantId, "product", ref, new Date("2026-09-30T18:00:00Z"));
    expect(sept30).toMatchObject({ confirmed: false, beforeArchive: false });
    expect(sept30!.version.content).toContain("🍂 SONBAHAR İNDİRİMİ");

    const oct2 = await textAt(db, tenantId, "product", ref, new Date("2026-10-02T12:00:00Z"));
    expect(oct2!.version.content).not.toContain("SONBAHAR");
    expect(oct2!.version.data.variants![0]!.compareAtPrice).toBeNull();
  });

  it("arşivden önceki sipariş: en eski kopya döner ama kesin olmadığı belirtilir", async () => {
    const r = await textAt(database.db, tenantId, "product", ref, new Date("2026-09-20T12:00:00Z"));
    expect(r).toMatchObject({ confirmed: false, beforeArchive: true });
    expect(r!.version.content).toContain("🍂 SONBAHAR İNDİRİMİ");
    expect(await textAt(database.db, tenantId, "product", "yok", T2)).toBeNull();
  });

  it("eski bir kopya, arşivdeki yeni kayıtların arkasına işlenemez", async () => {
    await expect(recordSnapshot(database.db, tenantId, "product", [productSnapshot(lavin())], T1)).rejects.toThrow(/daha yeni kayıt/);
  });

  it("mağazalar birbirinin arşivini görmez", async () => {
    const { db } = database;
    expect(await textAt(db, otherTenantId, "product", ref, T2)).toBeNull();
    await recordSnapshot(db, otherTenantId, "product", [productSnapshot(lavin({ body: BODY }))], T2);
    const own = await textAt(db, tenantId, "product", ref, new Date("2026-09-29T08:00:00Z"));
    expect(own!.version.content).toContain("🍂 SONBAHAR İNDİRİMİ");
  });
});

describe("vitrinden okuma", () => {
  it("mağaza adresini temizler; IP ve yerel adresleri reddeder", () => {
    expect(storefrontBase("https://MaiusOnline.com/collections/x?y=1")).toBe("https://maiusonline.com");
    for (const bad of ["localhost", "127.0.0.1", "http://10.0.0.1/", "maius"]) expect(() => storefrontBase(bad)).toThrow();
  });

  it("ürünleri sayfa sayfa okur", async () => {
    const many = Array.from({ length: 250 }, (_, i) => lavin({ id: i + 1 }));
    const { fetchImpl, calls } = fakeStorefront({
      "https://maiusonline.com/products.json?limit=250&page=1": [200, productsPage(many)],
      "https://maiusonline.com/products.json?limit=250&page=2": [200, productsPage([lavin({ id: 999 })])],
    });
    const items = await fetchStorefrontProducts("maiusonline.com", fetchImpl);
    expect(items).toHaveLength(251);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.userAgent).toMatch(/^Lina\//);
  });

  it("şifreli mağaza ya da sunucu hatası anlaşılır hata verir", async () => {
    const password = fakeStorefront({ "https://maiusonline.com/products.json?limit=250&page=1": [200, "<html>Şifre</html>"] });
    await expect(fetchStorefrontProducts("maiusonline.com", password.fetchImpl)).rejects.toThrow(/products.json kapalı/);
    const down = fakeStorefront({ "https://maiusonline.com/products.json?limit=250&page=1": [503, ""] });
    await expect(fetchStorefrontProducts("maiusonline.com", down.fetchImpl)).rejects.toThrow(/HTTP 503/);
  });
});

describe("vitrin güvenliği ve afişlerin kalkması", () => {
  it("iç ağ adları reddedilir", () => {
    for (const bad of ["metadata.google.internal", "printer.local", "nas.lan"]) expect(() => storefrontBase(bad)).toThrow();
  });

  it("yönlendirmeler denetlenir: https ve herkese açık adrese izin, diğerleri reddedilir", async () => {
    const fetchVia = (location: string) =>
      (async (url: string | URL | Request) => {
        if (String(url) === "https://shop.test/products.json?limit=250&page=1") {
          return new Response(null, { status: 301, headers: { location } });
        }
        return new Response(JSON.stringify({ products: [] }), { status: 200 });
      }) as typeof fetch;
    await expect(fetchStorefrontProducts("shop.test", fetchVia("https://www.shop.test/products.json?limit=250&page=1"))).resolves.toEqual([]);
    await expect(fetchStorefrontProducts("shop.test", fetchVia("http://169.254.169.254/latest/meta-data"))).rejects.toThrow(/izin verilmeyen adrese/);
    await expect(fetchStorefrontProducts("shop.test", fetchVia("https://metadata.google.internal/"))).rejects.toThrow(/izin verilmeyen adrese/);
  });

  it("çok büyük cevap okunmaz", async () => {
    const huge = (async () => new Response("x".repeat(16 * 1024 * 1024), { status: 200 })) as typeof fetch;
    await expect(fetchStorefrontProducts("shop.test", huge)).rejects.toThrow(/MB sınırını aşıyor/);
  });

  it("sayfa sağlam okundu ve hiç afiş kalmadıysa eski afişler kapanır; bakım sayfasında kapanmaz", async () => {
    const { db } = database;
    const [shop] = await db.insert(tenants).values({ slug: "afis", name: "Afiş" }).returning();
    await recordSnapshot(db, shop!.id, "site", extractSiteTexts(HOME), new Date("2026-09-28T10:00:00Z"));

    const maintenance = siteTextsOf("<html><body>Bakımdayız</body></html>");
    expect(maintenance.authoritative).toBe(false);
    const kept = await recordSnapshot(db, shop!.id, "site", maintenance.items, new Date("2026-09-29T10:00:00Z"), {
      allowEmpty: maintenance.authoritative,
    });
    expect(kept.ended).toBe(0);

    const noBanners = siteTextsOf('<div id="shopify-section-template--1__main" class="shopify-section">Ürünler</div>');
    expect(noBanners).toEqual({ items: [], authoritative: true });
    const closed = await recordSnapshot(db, shop!.id, "site", noBanners.items, new Date("2026-10-01T10:00:00Z"), {
      allowEmpty: noBanners.authoritative,
    });
    expect(closed.ended).toBe(3);
    expect(await currentTexts(db, shop!.id, "site")).toEqual([]);
  });
});

describe("arşiv senkronu", () => {
  it("ürün ve site yazılarını işler; bir kaynağın hatası diğerini durdurmaz", async () => {
    const { db } = database;
    const [shop] = await db.insert(tenants).values({ slug: "senkron", name: "Senkron", domain: "senkron-shop.com" }).returning();
    let productsUp = true;
    const { fetchImpl } = fakeStorefront({
      "https://senkron-shop.com/products.json?limit=250&page=1": () => (productsUp ? [200, productsPage([lavin()])] : [500, ""]),
      "https://senkron-shop.com/": [200, HOME],
    });
    let clock = new Date("2026-09-28T12:00:00Z").getTime();
    const now = () => new Date((clock += 60_000));

    const first = await archiveTenant(db, shop!, { fetch: fetchImpl, now });
    expect(first.errors).toEqual([]);
    expect(first.products).toMatchObject({ added: 1 });
    expect(first.site).toMatchObject({ added: 3 });
    // Mağaza bilgi uzmanı güncel kampanya yazılarını ayrı bir kaynak olarak görür.
    const [digest] = await db
      .select()
      .from(knowledgeDocs)
      .where(and(eq(knowledgeDocs.tenantId, shop!.id), eq(knowledgeDocs.source, "campaign")));
    expect(digest).toMatchObject({ kind: "core", autoEnabled: true, title: "Güncel kampanya ve duyuru yazıları" });
    expect(digest!.content).toContain("- 3.000 TL ve üzeri siparişlerde ücretsiz kargo");

    productsUp = false;
    const second = await archiveTenant(db, shop!, { fetch: fetchImpl, now });
    expect(second.errors).toEqual([expect.stringMatching(/^ürünler: .*HTTP 500/)]);
    expect(second.site).toMatchObject({ unchanged: 3 });
    // Ürün hatası arşivdeki ürünü "kalktı" saymadı.
    expect(await currentTexts(db, shop!.id, "product")).toHaveLength(1);
  });

  it("adresi olmayan ve Shopify uygulamasını kaldıran mağazalar atlanır", async () => {
    const { db } = database;
    const [a, , c] = await db
      .insert(tenants)
      .values([
        { slug: "a", name: "A", domain: "a-shop.com" },
        { slug: "b", name: "B" },
        { slug: "c", name: "C", domain: "c-shop.com" },
      ])
      .returning();
    await db.insert(shopifyStores).values({
      tenantId: c!.id, shopDomain: "c-shop.myshopify.com", scopes: "read_products", accessTokenEnc: "x", uninstalledAt: new Date(),
    });
    const { fetchImpl, calls } = fakeStorefront({});
    const errors: string[] = [];
    await archiveAllTenants(db, { info: () => {}, error: (m: string) => errors.push(m) }, { fetch: fetchImpl });
    const hosts = new Set(calls.map((x) => new URL(x.url).host));
    expect(hosts.has("a-shop.com")).toBe(true);
    expect(hosts.has("c-shop.com")).toBe(false);
    expect(errors.some((e) => e.startsWith(`[${a!.slug}] arşiv hatası`))).toBe(true); // sahte vitrin 404
  });
});
