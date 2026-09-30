import type { TextAt } from "../archive/archive.js";
import type { OrderFacts, OrderItem, Shipment } from "./types.js";

/**
 * Sipariş bilgi kartı: sipariş uzmanına giden, koddan üretilen olgular.
 * - Kampanya ve ön sipariş satırları her ürünün en başına, sipariş tarihindeki haliyle ve
 *   kısaltılmadan konur (docs/lina-davranis.md "Kampanya yazıları").
 * - Gecikme ve eksik takip numarası kodda tespit edilir; modelin hatırlamasına bırakılmaz.
 * - Tutar, ödeme ve adres kartta yoktur (zaten çekilmez).
 */

/** return_review: iade uzmanı talebin ekip kararı gerektirdiğine karar verdi (ör. kural dışı istek). */
export type OrderIssue = { kind: "delay" | "no_tracking" | "return_review"; orderName: string; text: string };

/** Ürünün sipariş tarihindeki yazısı (kampanya arşivinden). */
export type ProductTextAt = Pick<TextAt, "confirmed" | "beforeArchive"> & {
  version: Pick<TextAt["version"], "content" | "firstSeenAt">;
};

export type OrderSheet = {
  text: string;
  issues: OrderIssue[];
  /** Kargoya verilmemiş ürün var (iptal isteği bu durumda ekibe önemli bildirim olur). */
  unshipped: boolean;
  cancelled: boolean;
};

const MONTH_NAMES = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
/** Ay adları ASCII'ye katlanmış metinde aranır: "Eylül", "EYLÜL", "Eylul" hepsi "eylul". */
const MONTHS: Record<string, number> = {
  ocak: 1, subat: 2, mart: 3, nisan: 4, mayis: 5, haziran: 6, temmuz: 7, agustos: 8, eylul: 9, ekim: 10, kasim: 11, aralik: 12,
};
const WORD_DATE = new RegExp(`(?<!\\d)(\\d{1,2})\\s*(${Object.keys(MONTHS).join("|")})(?:\\s+(\\d{4}))?`, "gu");
/** "25.09", "25.09.2026", "25/09/2026". Yılsız "3/4" kesir olabilir (ör. "3/4 kollu"): yılsız "/" alınmaz. */
const NUMERIC_DATE = /(?<![\d./])(\d{1,2})([./])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d./])/gu;
const DAY_MS = 86_400_000;

/**
 * Karşılaştırma için katlama: Türkçe küçük harf, sonra Türkçe harfler ASCII'ye.
 * "EKIM" (noktasız I ile yazılmış), "EKİM" ve "Ekim" hepsi "ekim" olur. Uzunluk değişmez.
 */
export function fold(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

/** Mağazanın saat diliminde gün: "2026-09-25" (metin olarak karşılaştırılabilir). */
export function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "2026-09-25" → "25 Eylül 2026" */
export function longDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m! - 1]} ${y}`;
}

const dayOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Gün/ay/yıl geçerliyse "YYYY-AA-GG"; yıl yoksa sipariş yılı (60 günden fazla önceye düşerse ertesi yıl). */
function resolveDay(day: number, month: number, year: number | undefined, orderDay: string): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const orderYear = Number(orderDay.slice(0, 4));
  let result = dayOf(year ?? orderYear, month, day);
  if (!year && dayMs(result) < dayMs(orderDay) - 60 * DAY_MS) result = dayOf(orderYear + 1, month, day);
  // 31 Şubat gibi olmayan günler.
  if (new Date(dayMs(result)).toISOString().slice(0, 10) !== result) return null;
  return result;
}

/**
 * Metindeki tarih: önce ay adıyla yazılanlar ("25 Eylül", "25 EYLÜL 2026"), yoksa sayısal
 * ("25.09.2026"). Beden ("36/38") ya da kesir ("3/4 kollu") gibi tarih olmayan sayılar atlanır.
 */
export function findDate(text: string, orderDay: string): string | null {
  const folded = fold(text);
  for (const m of folded.matchAll(WORD_DATE)) {
    const day = resolveDay(Number(m[1]), MONTHS[m[2]!]!, m[3] ? Number(m[3]) : undefined, orderDay);
    if (day) return day;
  }
  for (const m of folded.matchAll(NUMERIC_DATE)) {
    const yearText = m[4];
    if (!yearText && m[2] !== ".") continue;
    const year = yearText ? (yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText)) : undefined;
    const day = resolveDay(Number(m[1]), Number(m[3]), year, orderDay);
    if (day) return day;
  }
  return null;
}

const SPECIAL = /on\s*siparis|on\s*satis|pre-?order|kampanya|indirim|iade|degisim|kargoya|teslim|\bsale\b|return/u;
const STARTS_WITH_EMOJI = /^\p{Extended_Pictographic}/u;

/** Açıklamadaki özel koşul satırları (aynen): kampanya, ön sipariş, iade/değişim, kargo/teslim. */
export function specialLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter((l) => l && (STARTS_WITH_EMOJI.test(l) || SPECIAL.test(fold(l))));
}

const PREORDER = /on\s*siparis|on\s*satis|pre-?order/u;
/** "Kırık Beyaz renk stoktan çıkmaktadır": stoktaki varyantları anlatan cümle. */
const IN_STOCK = /stok/u;

type VariantInfo = Pick<OrderItem, "variantTitle" | "options" | "productOptionValues">;

/**
 * applies: ön sipariş yazısı bu varyantı kapsıyor.
 * inStock: açıklama bu varyantın stoktan çıktığını açıkça söylüyor.
 */
export type Preorder = { line: string; date: string | null; applies: boolean; inStock: boolean };

function mentions(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

/** Ürünün harf içeren seçenek değerleri (renk gibi; "1–36/38" gibi bedenler hariç), katlanmış. */
function optionValues(item: VariantInfo): string[] {
  return [...new Set([...item.productOptionValues, ...item.options.map((o) => o.value)])]
    .map((v) => fold(v.trim()))
    .filter((v) => v.length >= 3 && /\p{L}/u.test(v));
}

const ownValues = (item: VariantInfo) => fold([item.variantTitle ?? "", ...item.options.map((o) => o.value)].join(" / "));

/**
 * Açıklamadaki ön sipariş bilgisi ve bu varyantı kapsayıp kapsamadığı. Birden fazla ön sipariş satırı
 * olabilir (ör. her renk için ayrı tarih): bu varyantı kapsayan ilk satır alınır. Bir satır belirli
 * seçenekleri ("Siyah renk") anıyorsa yalnızca onları, hiçbirini anmıyorsa ürünün tamamını kapsar.
 */
export function preorderFor(text: string, item: VariantInfo, orderDay: string): Preorder | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const values = optionValues(item);
  const own = ownValues(item);
  const candidates = lines.flatMap((line, i) => {
    if (!PREORDER.test(fold(line))) return [];
    const sentences = line.split(/(?<=[.!?])\s+/);
    const stock = sentences.filter((s) => IN_STOCK.test(fold(s)));
    const scope = fold(sentences.filter((s) => !IN_STOCK.test(fold(s))).join(" "));
    const next = lines[i + 1];
    // Tarih bazen bir sonraki satırda yazılır (o satır başka bir ön sipariş satırı değilse).
    const date =
      findDate(scope, orderDay) ?? (next && !PREORDER.test(fold(next)) ? findDate(next, orderDay) : null);
    const mentioned = values.filter((v) => mentions(scope, v));
    const applies = mentioned.length === 0 || mentioned.some((v) => mentions(own, v));
    const inStock = stock.some((s) => values.some((v) => mentions(fold(s), v) && mentions(own, v)));
    return [{ line, date, applies, inStock }];
  });
  if (!candidates.length) return null;
  const applying = candidates.find((c) => c.applies);
  if (applying) return { ...applying, inStock: false };
  return { line: candidates[0]!.line, date: null, applies: false, inStock: candidates.some((c) => c.inStock) };
}

const SHIPMENT_STATUS: Record<string, string> = {
  LABEL_PRINTED: "kargo etiketi hazır",
  LABEL_PURCHASED: "kargo etiketi hazır",
  CONFIRMED: "kargoya verildi",
  SUCCESS: "kargoya verildi",
  FULFILLED: "kargoya verildi",
  CARRIER_PICKED_UP: "kargo firması teslim aldı",
  IN_TRANSIT: "yolda",
  OUT_FOR_DELIVERY: "dağıtımda",
  ATTEMPTED_DELIVERY: "teslim denendi",
  READY_FOR_PICKUP: "teslim noktasında",
  PICKED_UP: "teslim alındı",
  DELIVERED: "teslim edildi",
  NOT_DELIVERED: "teslim edilemedi",
  FAILURE: "teslimatta sorun var",
};

/** Mağazadan teslim almada kargo takip numarası olmaz. */
const PICKUP_STATUS = new Set(["READY_FOR_PICKUP", "PICKED_UP"]);

const isDelivered = (s: Shipment) => Boolean(s.deliveredAt) || s.status === "DELIVERED";

/** Takip numarası beklenen gönderim mi? (Dijital ürün, mağazadan teslim ve teslim edilmiş olanlar hariç.) */
const needsTracking = (s: Shipment) => s.requiresShipping && !PICKUP_STATUS.has(s.status) && !isDelivered(s);

function shipmentStatus(s: Shipment, timeZone: string): string {
  if (s.deliveredAt) return `teslim edildi (${longDate(localDate(s.deliveredAt, timeZone))})`;
  return SHIPMENT_STATUS[s.status] ?? s.status.toLocaleLowerCase("tr");
}

function statusLabel(order: OrderFacts, active: OrderItem[], waiting: OrderItem[], timeZone: string): string {
  const fmt = (d: Date) => longDate(localDate(d, timeZone));
  if (order.cancelledAt) return `İptal edildi (${fmt(order.cancelledAt)})`;
  if (!active.length) return "Siparişteki ürünlerin hepsi iade edildi ya da siparişten çıkarıldı";
  if (!waiting.length) {
    if (order.shipments.length && order.shipments.every(isDelivered)) {
      const last = order.shipments
        .map((s) => s.deliveredAt)
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return last ? `Teslim edildi (${fmt(last)})` : "Teslim edildi";
    }
    return "Kargoya verildi";
  }
  if (order.shipments.length) return "Kısmen kargoya verildi (bazı ürünler henüz gönderilmedi)";
  return "Hazırlanıyor (henüz kargoya verilmedi)";
}

function itemState(item: OrderItem, order: OrderFacts, timeZone: string): string {
  if (item.quantity === 0) return "siparişten çıkarıldı ya da iade edildi";
  if (order.cancelledAt) return `${item.quantity} adet (sipariş iptal)`;
  if (item.unfulfilled === item.quantity) return `${item.quantity} adet, henüz kargoya verilmedi`;
  const shipment = order.shipments.find((s) => s.itemIds.includes(item.id));
  const where = shipment
    ? ` (${longDate(localDate(shipment.createdAt, timeZone))}${shipment.carrier ? `, ${shipment.carrier}` : ""}; ${shipmentStatus(shipment, timeZone)})`
    : "";
  if (item.unfulfilled === 0) return `${item.quantity} adet, kargoya verildi${where}`;
  return `${item.quantity} adet: ${item.quantity - item.unfulfilled} adedi kargoya verildi${where}, ${item.unfulfilled} adedi bekliyor`;
}

function sourceNote(archived: ProductTextAt | null, item: OrderItem, timeZone: string): string {
  const since = archived ? longDate(localDate(archived.version.firstSeenAt, timeZone)) : "";
  if (archived?.beforeArchive) {
    return `kampanya arşivindeki en eski kayıt (${since}); sipariş bundan önce verildi, o gün aynı yazı olduğu kesin değil`;
  }
  if (archived) return archived.confirmed ? "kampanya arşivi (sipariş gününde kayıtlı yazı)" : `kampanya arşivi (sipariş gününden önceki son kayıt, ${since}'dan beri)`;
  if (item.currentDescription !== null) return "bugünkü ürün açıklaması (arşivde kayıt yok)";
  return "ürün açıklaması bulunamadı";
}

/** Siparişin bilgi kartı; `texts` ürün kimliğine göre sipariş tarihindeki arşiv kaydıdır. */
export function buildOrderSheet(
  order: OrderFacts,
  texts: Map<string, ProductTextAt | null>,
  now: Date,
  timeZone: string,
): OrderSheet {
  const fmt = (d: Date) => longDate(localDate(d, timeZone));
  const today = localDate(now, timeZone);
  const orderDay = localDate(order.createdAt, timeZone);
  const cancelled = Boolean(order.cancelledAt);
  const active = order.items.filter((i) => i.quantity > 0);
  const waiting = active.filter((i) => i.unfulfilled > 0);
  const issues: OrderIssue[] = [];

  const lines = [
    `SİPARİŞ ${order.name} (doğrulandı: müşterinin WhatsApp numarasıyla eşleşiyor)`,
    `Sipariş tarihi: ${longDate(orderDay)} · Bugün: ${longDate(today)}`,
    `Durum: ${statusLabel(order, active, waiting, timeZone)}`,
    "",
    "ÜRÜNLER",
  ];

  order.items.forEach((item, i) => {
    const variant = item.variantTitle ? ` (${item.variantTitle})` : "";
    lines.push(`${i + 1}. ${item.title}${variant}: ${itemState(item, order, timeZone)}`);

    const archived = item.productId ? (texts.get(item.productId) ?? null) : null;
    const text = archived?.version.content ?? item.currentDescription ?? "";
    const special = specialLines(text);
    if (special.length) {
      lines.push("   Özel koşullar (sipariş tarihindeki ürün açıklamasından, aynen):");
      for (const s of special) lines.push(`   • ${s}`);
    }

    const pre = text ? preorderFor(text, item, orderDay) : null;
    if (pre && item.quantity > 0) {
      if (!pre.applies) {
        lines.push(
          pre.inStock
            ? "   → Açıklamaya göre bu varyant stoktan; ön sipariş yazısı başka varyantlar için."
            : "   → Ön sipariş yazısı bu varyantı anmıyor; bu varyantın ön sipariş olup olmadığı açıklamadan anlaşılamıyor.",
        );
      } else if (!pre.date) lines.push("   → Ön sipariş ürünü; açıklamada okunabilir bir kargo tarihi yok.");
      else {
        const late = !cancelled && item.unfulfilled > 0 && today > pre.date;
        // Açıklamadaki tarih sipariş verildiğinde zaten geçmişti: sayfa güncellenmemiş.
        const staleAtOrder = pre.date < orderDay;
        const state =
          item.unfulfilled === 0
            ? "ürün kargoya verildi"
            : late
              ? `tarih geçti${staleAtOrder ? " (bu tarih sipariş verildiğinde de geçmişti; ürün sayfası güncellenmemiş)" : ""}, ürün henüz kargoya verilmedi: GECİKME`
              : "tarih henüz gelmedi";
        lines.push(`   → Ön sipariş (bu varyant): planlanan kargo ${longDate(pre.date)}; ${state}.`);
        if (late) {
          issues.push({
            kind: "delay",
            orderName: order.name,
            text: staleAtOrder
              ? `Gecikme: ${item.title}${variant}; ürün sayfasındaki ön sipariş tarihi (${longDate(pre.date)}) sipariş gününden önce kalmış, sayfa güncellenmeli`
              : `Gecikme: ${item.title}${variant}, planlanan kargo ${longDate(pre.date)}`,
          });
        }
      }
    }

    lines.push(`   Kaynak: ${sourceNote(archived, item, timeZone)}`);
    // Bugünkü açıklama farklıysa (ör. kampanya bitti, yazı silindi) o da görülsün.
    if (archived && item.currentDescription !== null) {
      const todays = specialLines(item.currentDescription);
      if (todays.join("\n") !== special.join("\n")) {
        lines.push(`   Bugünkü açıklamadaki özel koşullar: ${todays.length ? todays.join(" | ") : "yok"}`);
      }
    }
    if (text) lines.push(`   Ürün açıklaması (tamamı): ${text.replace(/\n+/g, " ")}`);
  });

  if (order.shipments.length) {
    lines.push("", "KARGO");
    for (const s of order.shipments) {
      const itemNos = s.itemIds.map((id) => order.items.findIndex((i) => i.id === id) + 1).filter((n) => n > 0);
      const parts = [fmt(s.createdAt), s.carrier ?? (PICKUP_STATUS.has(s.status) ? "mağazadan teslim" : "kargo firması belirtilmemiş")];
      if (s.trackingNumber) parts.push(`takip no ${s.trackingNumber}`);
      if (s.trackingUrl) parts.push(`takip linki ${s.trackingUrl}`);
      parts.push(`durum: ${shipmentStatus(s, timeZone)}`);
      if (itemNos.length) parts.push(`ürün ${itemNos.join(", ")}`);
      lines.push(`- ${parts.join(" · ")}`);
      if (!s.trackingNumber && !s.trackingUrl && needsTracking(s) && !cancelled) {
        lines.push("  ⚠️ Bu gönderimin takip numarası girilmemiş.");
        issues.push({ kind: "no_tracking", orderName: order.name, text: `Takip numarası yok: ${fmt(s.createdAt)} tarihli gönderim` });
      }
    }
  }

  if (issues.length) lines.push("", `EKİBE BİLDİRİLECEK (otomatik): ${issues.map((x) => x.text).join(" · ")}`);
  lines.push("", "Paylaşılmaz: tutar, ödeme bilgisi, adres.");

  return { text: lines.join("\n"), issues, unshipped: !cancelled && waiting.length > 0, cancelled };
}

/** Sipariş listesindeki tek satır: numara, tarih, durum, ürünler. */
export function orderSummaryLine(order: OrderFacts, timeZone: string): string {
  const active = order.items.filter((i) => i.quantity > 0);
  const waiting = active.filter((i) => i.unfulfilled > 0);
  const titles = active.slice(0, 3).map((i) => i.title).join(", ") + (active.length > 3 ? ` ve ${active.length - 3} ürün daha` : "");
  return `${order.name} · ${longDate(localDate(order.createdAt, timeZone))} · ${statusLabel(order, active, waiting, timeZone)} · ${titles}`;
}
