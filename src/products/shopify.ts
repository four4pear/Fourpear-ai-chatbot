import type { ShopifyStore } from "../db/schema.js";
import type { ShopifyApi } from "../shopify/client.js";
import { sanitizeQuery, stockState, type ProductFacts, type ProductSource } from "./types.js";

// Stok adedi yalnızca durum çıkarmak için okunur; müşteriye ya da uzmana gitmez.
const PRODUCTS_QUERY = `#graphql
query LinaProducts($query: String!, $first: Int!) {
  products(first: $first, query: $query, sortKey: RELEVANCE) {
    nodes {
      title
      onlineStoreUrl
      tags
      description(truncateAt: 1500)
      variants(first: 60) {
        nodes {
          title
          availableForSale
          inventoryQuantity
          price
          compareAtPrice
        }
      }
    }
  }
}`;

type GqlProduct = {
  title: string;
  onlineStoreUrl: string | null;
  tags: string[];
  description: string;
  variants: { nodes: { title: string; availableForSale: boolean; inventoryQuantity: number | null; price: string; compareAtPrice: string | null }[] };
};

export function toProductFacts(p: GqlProduct, currency = "TRY"): ProductFacts {
  const variants = p.variants.nodes.map((v) => ({
    // Tek varyantlı ürünün varyantı "Default Title" adını taşır: anlamsız, gösterilmez.
    title: v.title === "Default Title" ? "Standart" : v.title,
    price: Number(v.price),
    compareAtPrice: v.compareAtPrice !== null ? Number(v.compareAtPrice) : null,
    stock: stockState(v),
  }));
  return { title: p.title, url: p.onlineStoreUrl, tags: p.tags, description: p.description.replace(/\s+/g, " ").trim(), currency, variants };
}

/** Shopify mağazasının aktif ürünleri (fiyat, beden/renk, stok durumu) anlık okunur. */
export function shopifyProductSource(api: ShopifyApi, store: ShopifyStore, opts: { currency?: string } = {}): ProductSource {
  return {
    async search(query, limit = 5) {
      const text = sanitizeQuery(query);
      if (!text) return [];
      const data = await api.graphql<{ products: { nodes: GqlProduct[] } }>(store, PRODUCTS_QUERY, {
        query: `${text} status:active`,
        first: Math.min(Math.max(limit, 1), 8),
      });
      return data.products.nodes.map((p) => toProductFacts(p, opts.currency));
    },
  };
}
