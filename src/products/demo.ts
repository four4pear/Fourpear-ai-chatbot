import { stockState, type ProductFacts, type ProductSource, type ProductVariant } from "./types.js";

/**
 * Simülatör ve panel test ekranı için deneme ürünleri (deneme siparişleriyle birlikte açılır). Uydurmadır;
 * gerçek bir mağazanın stoğu değildir. Stok durumları bilerek çeşitlidir: stokta, az kaldı, tükendi, ön sipariş.
 */
const PREORDER_SIYAH =
  "🕒 ÖN SİPARİŞ: Siyah renk ön sipariş kapsamındadır; siparişler 25 Eylül tarihinde kargoya teslim edilir. Kırık Beyaz renk stoktan çıkmaktadır.";
const CAMPAIGN =
  "🍂 SONBAHAR İNDİRİMİ: Bu ürün 30 Eylül'e kadar indirimli fiyatla satışa sunulmaktadır. Sonbahar İndirimi kapsamında indirimli ürünlerde 14 günlük iade ve değişim uygulanmamaktadır.";

type Row = [title: string, price: number, compareAt: number | null, inventory: number | null, availableForSale?: boolean];

function product(title: string, description: string, rows: Row[], tags: string[] = []): ProductFacts {
  const variants: ProductVariant[] = rows.map(([variant, price, compareAtPrice, inventoryQuantity, availableForSale = true]) => ({
    title: variant,
    price,
    compareAtPrice,
    stock: stockState({ availableForSale, inventoryQuantity }),
  }));
  return { title, url: `https://demo.example/products/${title.toLocaleLowerCase("tr-TR").replace(/\s+/g, "-")}`, tags, description, currency: "TRY", variants };
}

const PRODUCTS: ProductFacts[] = [
  product("Maius Lavin Etek", `${PREORDER_SIYAH}\n${CAMPAIGN}\nPoplin kumaştan üretilmektedir.`, [
    ["Siyah / 1–36/38", 1490, 1990, 0], // stok yok, ön sipariş açık
    ["Siyah / 2–40/42", 1490, 1990, 0],
    ["Kırık Beyaz / 1–36/38", 1490, 1990, 12],
    ["Kırık Beyaz / 2–40/42", 1490, 1990, 2],
  ]),
  product("Maius Riva Takım", `${CAMPAIGN}\nAkıcı dokulu kumaştan iki parça takım.`, [
    ["Vizon / 1–36/38", 2490, 3290, 0, false],
    ["Vizon / 2–40/42", 2490, 3290, 6],
  ]),
  product("Mira Gömlek", "Pamuklu gömlek. Stoktan gönderilir. Model 1,75 boyunda, 38 beden giyiyor.", [
    ["Beyaz / 1–36/38", 1290, null, 9],
    ["Beyaz / 2–40/42", 1290, null, 0, false],
    ["Mavi / 1–36/38", 1290, null, 3],
    ["Mavi / 2–40/42", 1290, null, 5],
  ]),
  product("Zen Takım", "Keten karışımlı takım.", [
    ["Haki / 1–36/38", 2190, null, 7],
    ["Haki / 2–40/42", 2190, null, 4],
  ]),
  product("Luna Kaban", "Yumuşak dokulu kaban.", [
    ["Camel / 2–40/42", 3490, null, 0, false],
    ["Siyah / 1–36/38", 3490, null, 8],
    ["Siyah / 2–40/42", 3490, null, 5],
  ]),
  product("Nova Triko Hırka", "Yumuşak triko hırka.", [
    ["Ekru / 1–36/38", 1190, null, 15],
    ["Gri / 1–36/38", 1190, null, 15],
  ]),
];

/** Harf farklarını (İ/ı, ş, ğ…) yok sayan arama metni. */
const fold = (s: string) =>
  s.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");

export function demoProductSource(): ProductSource {
  return {
    async search(query, limit = 5) {
      const words = fold(query).split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      return PRODUCTS.filter((p) => words.every((w) => fold(p.title).includes(w))).slice(0, limit);
    },
  };
}
