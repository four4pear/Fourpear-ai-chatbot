/**
 * Ürün, fiyat ve stok bilgisi (ürün uzmanı için). Stok sayısı hiçbir zaman uzmana ya da müşteriye gitmez:
 * yalnızca durum söylenir (stokta, az kaldı, tükendi, sipariş alınıyor).
 */
export type StockState = "in_stock" | "low" | "sold_out" | "backorder";

export type ProductVariant = {
  /** Seçenekler birleşik, ör. "Siyah / 38". */
  title: string;
  price: number;
  compareAtPrice: number | null;
  stock: StockState;
};

export type ProductFacts = {
  title: string;
  url: string | null;
  tags: string[];
  /** Mağazanın ürün yazısı (düz metin); kampanya ve ön sipariş satırları da burada. */
  description: string;
  currency: string;
  variants: ProductVariant[];
  /** Çok markalı hatta ürünün markası; tek mağazada boş. */
  brand?: string;
};

export interface ProductSource {
  /** Ürün adıyla arar (aktif ürünler); en fazla `limit` ürün döner. */
  search(query: string, limit?: number): Promise<ProductFacts[]>;
}

/** Bu ve altındaki stok "az sayıda kaldı" sayılır. */
export const LOW_STOCK = 3;

export function stockState(v: { availableForSale: boolean; inventoryQuantity: number | null }): StockState {
  if (!v.availableForSale) return "sold_out";
  // Satılabilir ama sayı sıfır ya da altında: stok dışı satışa (ön sipariş/üretim) açık.
  if (v.inventoryQuantity !== null && v.inventoryQuantity <= 0) return "backorder";
  if (v.inventoryQuantity !== null && v.inventoryQuantity <= LOW_STOCK) return "low";
  return "in_stock";
}

const STOCK_TEXT: Record<StockState, string> = {
  in_stock: "stokta var",
  low: "az sayıda kaldı",
  sold_out: "tükendi",
  backorder: "stokta yok, ön sipariş/üretim süreciyle sipariş alınıyor (ürün yazısındaki koşula bak)",
};

/** Arama metninden Shopify arama operatörlerini ve tırnakları atar (model "status:draft" gibi bir şey yazamasın). */
export function sanitizeQuery(raw: string): string {
  return raw.replace(/["':()\\*]/g, " ").replace(/\b(AND|OR|NOT)\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

const money = (n: number, currency: string) =>
  `${n.toLocaleString("tr-TR", { maximumFractionDigits: 2 })} ${currency === "TRY" ? "TL" : currency}`;

function priceLine(p: ProductFacts): string {
  const prices = p.variants.map((v) => v.price);
  if (!prices.length) return "Fiyat bilgisi yok";
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = min === max ? money(min, p.currency) : `${money(min, p.currency)} – ${money(max, p.currency)}`;
  // İndirim: karşılaştırma fiyatı satış fiyatından yüksekse (en büyük indirimli varyanta göre).
  const discounted = p.variants.filter((v) => v.compareAtPrice !== null && v.compareAtPrice > v.price);
  if (!discounted.length) return range;
  const before = Math.max(...discounted.map((v) => v.compareAtPrice!));
  return `${range} (indirimli; önceki fiyat ${money(before, p.currency)})`;
}

/** Ürün uzmanına giden okunaklı özet: sayı yok, yalnızca stok durumu. */
export function describeProducts(products: ProductFacts[]): string {
  if (!products.length) return "Eşleşen aktif ürün bulunamadı.";
  return products
    .map((p) => {
      const lines = [`Ürün: ${p.title}${p.url ? ` — ${p.url}` : ""}`, ...(p.brand ? [`Marka: ${p.brand}`] : []), `Fiyat: ${priceLine(p)}`];
      if (p.variants.length) lines.push("Seçenekler:", ...p.variants.map((v) => `- ${v.title}: ${STOCK_TEXT[v.stock]}`));
      if (p.tags.length) lines.push(`Etiketler: ${p.tags.join(", ")}`);
      if (p.description) lines.push(`Mağazanın ürün yazısı (kampanya ve ön sipariş koşulları bağlayıcıdır): ${p.description}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
