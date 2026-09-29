import { htmlToText } from "../knowledge/html.js";
import type { TextSnapshot } from "./archive.js";

/**
 * Mağazanın herkese açık vitrininden okuma; Shopify uygulaması kurulu olmasa da çalışır.
 * Ürünler /products.json'dan, kampanya yazıları ana sayfanın tema bölümlerinden okunur.
 * Mağaza adresi (tenants.domain) yalnızca yönetici tarafından girilir.
 */

type Fetch = typeof fetch;

const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const USER_AGENT = "Lina/1.0 (kampanya arsivi)";
/** Tek bir sayfa en fazla bu kadar okunur (ana sayfa ~1 MB, 250 ürünlük liste ~1,5 MB). */
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** İç ağ ve yerel adlar: sunucu kendi ağındaki bir adrese istek atmasın. */
const PRIVATE_SUFFIX = /\.(internal|local|localhost|lan|home|corp|intranet|home\.arpa)$/;

/** Herkese açık bir alan adı mı? IP, yerel ve iç ağ adları reddedilir. */
function isPublicHost(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) && !PRIVATE_SUFFIX.test(host);
}

/** "https://MaiusOnline.com/" → "https://maiusonline.com"; IP, yerel ve iç ağ adresleri reddedilir. */
export function storefrontBase(domain: string): string {
  const host = domain.trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").toLowerCase();
  if (!isPublicHost(host)) throw new Error(`Geçersiz mağaza adresi: ${domain}`);
  return `https://${host}`;
}

/**
 * Sayfayı okur. Yönlendirmeler tek tek izlenir ve her adres yeniden denetlenir (yalnızca https ve
 * herkese açık alan adı); cevap boyutu sınırlıdır.
 */
async function getText(fetchImpl: Fetch, url: string): Promise<string> {
  let target = url;
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(target, {
      headers: { "user-agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) throw new Error(`${url} → çok fazla ya da geçersiz yönlendirme`);
      const next = new URL(location, target);
      if (next.protocol !== "https:" || !isPublicHost(next.hostname)) throw new Error(`${url} → izin verilmeyen adrese yönlendirme: ${next.host}`);
      target = next.toString();
      continue;
    }
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return readLimited(res, url);
  }
}

async function readLimited(res: Response, url: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`${url} → cevap ${MAX_BYTES / 1024 / 1024} MB sınırını aşıyor`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type StorefrontProduct = {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  tags: string[] | string;
  variants: { id: number; title: string; price: string; compare_at_price: string | null }[];
};

/** /products.json ürününü arşiv kaydına çevirir; stok durumu gibi sık değişen alanlar alınmaz. */
export function productSnapshot(p: StorefrontProduct): TextSnapshot {
  const tags = (Array.isArray(p.tags) ? p.tags : p.tags.split(","))
    .map((t) => t.trim())
    .filter(Boolean)
    .sort();
  return {
    ref: String(p.id),
    title: p.title,
    content: htmlToText(p.body_html ?? ""),
    data: {
      handle: p.handle,
      tags,
      variants: p.variants
        .map((v) => ({ id: String(v.id), title: v.title, price: v.price, compareAtPrice: v.compare_at_price ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

/** Kaydedilmiş ya da indirilmiş bir products.json gövdesini okur. */
export function parseProductsJson(body: string): StorefrontProduct[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const products = (parsed as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) {
    throw new Error("Ürün listesi okunamadı (mağaza şifreli ya da products.json kapalı olabilir)");
  }
  return products as StorefrontProduct[];
}

/** Vitrindeki bütün ürünler (sayfa sayfa, en fazla 10.000). */
export async function fetchStorefrontProducts(domain: string, fetchImpl: Fetch = fetch): Promise<TextSnapshot[]> {
  const base = storefrontBase(domain);
  const out: TextSnapshot[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const products = parseProductsJson(await getText(fetchImpl, `${base}/products.json?limit=${PAGE_SIZE}&page=${page}`));
    out.push(...products.map(productSnapshot));
    if (products.length < PAGE_SIZE) return out;
  }
  // Yarım liste arşive işlenmez: eksik ürünler "kalktı" sayılırdı.
  throw new Error(`${base}: vitrinde ${MAX_PAGES * PAGE_SIZE} üründen fazlası var`);
}

/** Kampanya ve duyuru taşıyan tema bölümleri. */
const CAMPAIGN_SECTION = /announcement|countdown|promo|popup|banner|marquee|scrolling|ticker|slideshow|slider|hero|rich[-_]?text|image[-_]with[-_]text|text[-_]with/i;
/** Menü, sepet, ürün listeleri ve alt bilgi gibi kalabalık bölümler. */
const NOISE_SECTION = /header|footer|cart|product|collection|recently|newsletter|search|menu|gallery|blog|testimonial|logo|instagram/i;

/**
 * Ana sayfa HTML'inden kampanya yazısı taşıyan tema bölümlerini çıkarır. Shopify temaları her
 * bölümü id="shopify-section-…" ile işaretler; bölümün metni bir sonraki bölüme kadar olan kısımdır.
 */
export function extractSiteTexts(html: string): TextSnapshot[] {
  const starts = [...html.matchAll(/<(?:section|div|aside|header|footer)\b[^>]*\bid="shopify-section-([^"]+)"[^>]*>/gi)];
  const out: TextSnapshot[] = [];
  starts.forEach((m, i) => {
    const id = m[1]!;
    // "template--123__countdown_sonbahar" → "countdown_sonbahar": tema yeniden yayınlanınca değişmeyen kısım.
    const key = id.includes("__") ? id.slice(id.lastIndexOf("__") + 2) : id;
    const cls = /\bclass="([^"]*)"/.exec(m[0])?.[1] ?? "";
    const section = /shopify-section--([\w-]+)/.exec(cls)?.[1] ?? key.replace(/[_-][A-Za-z0-9]{6}$/, "");
    const label = `${key} ${section}`;
    if (!CAMPAIGN_SECTION.test(label) || NOISE_SECTION.test(label)) return;
    const content = htmlToText(html.slice(m.index, starts[i + 1]?.index ?? html.length))
      .replace(COUNTDOWN, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (content) out.push({ ref: key, title: section, content, data: { section } });
  });
  return out;
}

/** Geri sayımın sayfadaki boş kalıbı ("00 Gün : 00 Saat : 00 Dk : 00 Sn"); sayıları tarayıcıda dolar. */
const COUNTDOWN = /(?:\d{1,3}\s*(?:gün|saat|dakika|dk|saniye|sn|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\s*:?\s*){2,}/giu;

/** Ana sayfadaki kampanya ve duyuru yazıları (üst bant, geri sayım, afiş…). */
export async function fetchSiteTexts(domain: string, fetchImpl: Fetch = fetch): Promise<SiteTexts> {
  return siteTextsOf(await getText(fetchImpl, `${storefrontBase(domain)}/`));
}

/**
 * authoritative: sayfa gerçekten bir Shopify teması (bölümleri var). O zaman hiç kampanya yazısı
 * bulunmaması "hepsi kaldırıldı" demektir; bakım ya da hata sayfasında ise hiçbir şey kapatılmaz.
 */
export type SiteTexts = { items: TextSnapshot[]; authoritative: boolean };

export function siteTextsOf(html: string): SiteTexts {
  return { items: extractSiteTexts(html), authoritative: /\bid="shopify-section-/.test(html) };
}
