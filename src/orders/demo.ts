import type { ReturnRequestInfo, ReturnsProvider } from "../returns/provider.js";
import { sameOrderNumber, type OrderFacts, type OrderItem, type OrderSource, type Shipment } from "./types.js";

/**
 * Simülatör ve panel test ekranı için deneme siparişleri (`npm run chat -- --demo-siparis`).
 * Uydurma siparişlerdir; gerçek müşteri verisi yoktur. Siparişler o an konuşan test müşterisine
 * aittir; #MO-9005 başka bir numaraya aittir (ad soyadla doğrulama denemesi).
 * Ürün açıklamaları (kampanya, ön sipariş) siparişin içinde de durur: arşivinde bu ürünler olmayan
 * mağazalarda da aynı senaryolar çalışır. MO-9001 ve MO-9002 dışındaki tarihler bugüne göre kurulur;
 * senaryolar zamanla bozulmaz (ör. "teslimden 4 gün sonra iade").
 */
/** Deneme senaryoları: sipariş, ne olduğu ve denemek için örnek müşteri mesajı (test ekranında tıklanır). */
export const DEMO_SCENARIOS = [
  { order: "MO-9001", label: "ön sipariş gecikmesi (planlanan tarih geçti)", sample: "MO-9001 siparişim ne zaman kargoya verilecek?" },
  { order: "MO-9002", label: "kampanyalı ürün, teslim edildi (kampanyada iade yok)", sample: "MO-9002 siparişimi iade etmek istiyorum" },
  { order: "MO-9003", label: "kampanyasız ürün, 4 gün önce teslim edildi (normal iade / değişim)", sample: "MO-9003 beden büyük geldi, değiştirmek istiyorum" },
  { order: "MO-9004", label: "kargoya verildi ama takip numarası yok", sample: "MO-9004 kargo takip numaram nerede?" },
  { order: "MO-9005", label: "başka numaranın siparişi: ad soyad (Zeynep Kaya) ya da telefon 0555 999 99 99 + ad soyadla doğrulanır", sample: "MO-9005 siparişim nerede?" },
  { order: "MO-9006", label: "hazırlanıyor, kargoya verilmedi (iptal ya da beden/adres değişikliği)", sample: "MO-9006 siparişimi iptal etmek istiyorum" },
  { order: "MO-9007", label: "kargoda, takip linki var (kargoya verildikten sonra iptal)", sample: "MO-9007 kargom nerede?" },
  { order: "MO-9008", label: "ön sipariş, tarihi henüz gelmedi", sample: "MO-9008 siparişim ne zaman gelir?" },
  { order: "MO-9009", label: "iptal edilmiş sipariş (para iadesi ne zaman?)", sample: "MO-9009 iptal oldu, param ne zaman yatar?" },
  { order: "MO-9010", label: "kısmen kargoda: bir ürün yolda, biri bekliyor", sample: "MO-9010 siparişimin bir kısmı gelmedi" },
  { order: "MO-9011", label: "40 gün önce teslim edildi (iade süresi geçmiş)", sample: "MO-9011 iade etmek istiyorum" },
  { order: "MO-9012", label: "açık iade talebi: ürün depoya ulaştı, inceleniyor", sample: "MO-9012 iadem ne durumda?" },
  { order: "MO-9013", label: "iade 50 gün önce depoya ulaştı, onaylandı ama para hâlâ yatmadı", sample: "MO-9013 iadem 50 gündür yatmadı" },
  { order: "MO-9014", label: "dün teslim edildi (yanlış ya da hasarlı ürün denemesi)", sample: "MO-9014 siyah istedim bej geldi" },
];

export const DEMO_ORDERS_HELP = DEMO_SCENARIOS.map((s) => `#${s.order}  ${s.label}`);

const OTHER_PHONE = "905559999999";
/** Deneme siparişlerinde kayıtlı ad soyadlar (numara tutmayınca ad soyadla doğrulama denemesi için). */
const CUSTOMER_NAME = "Ayşe Yılmaz";
const OTHER_NAME = "Zeynep Kaya";

const PREORDER_SIYAH =
  "🕒 ÖN SİPARİŞ: Siyah renk ön sipariş kapsamındadır; siparişler 25 Eylül tarihinde kargoya teslim edilir. Kırık Beyaz renk stoktan çıkmaktadır.";
const CAMPAIGN =
  "🍂 SONBAHAR İNDİRİMİ: Bu ürün 30 Eylül'e kadar indirimli fiyatla satışa sunulmaktadır. Sonbahar İndirimi kapsamında indirimli ürünlerde 14 günlük iade ve değişim uygulanmamaktadır; yalnızca hasarlı, hatalı veya yanlış gönderilen ürünlerde değişim veya iade yapılır.";

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
/** Deneme siparişleri Türkiye saatiyle kurulur (+03:00, yaz saati yok). */
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Bugüne göre tarih: ago(4, "11:00") → 4 gün önce saat 11:00 (Türkiye). */
function clock(now: Date) {
  const localDay = (days: number) => {
    const d = new Date(now.getTime() + TR_OFFSET_MS - days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  };
  return {
    ago: (days: number, hm = "12:00") => new Date(`${localDay(days)}T${hm}:00+03:00`),
    /** Açıklamalarda yazan biçimde gün ve ay, ör. "12 Ekim". */
    dayMonth: (daysAhead: number) => {
      const [, m, d] = localDay(-daysAhead).split("-").map(Number);
      return `${d} ${MONTHS[m! - 1]}`;
    },
    isoDay: localDay,
  };
}
const at = (iso: string) => new Date(`${iso}+03:00`);

function item(
  id: string,
  productId: string,
  title: string,
  variantTitle: string,
  optionValues: string[],
  unfulfilled: number,
  description: string,
): OrderItem {
  const names = variantTitle.split(" / ");
  return {
    id,
    productId,
    title,
    variantTitle,
    options: names.map((value, i) => ({ name: i === 0 && /\d/.test(value) ? "Beden" : "Renk", value })),
    productOptionValues: optionValues,
    quantity: 1,
    unfulfilled,
    currentDescription: description,
  };
}

function shipment(createdAt: Date, itemIds: string[], opts: Partial<Shipment> = {}): Shipment {
  return {
    createdAt,
    status: "IN_TRANSIT",
    deliveredAt: null,
    carrier: "Yurtiçi Kargo",
    trackingNumber: null,
    trackingUrl: null,
    itemIds,
    requiresShipping: true,
    ...opts,
  };
}

const tracking = (no: string) => ({
  trackingNumber: no,
  trackingUrl: `https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula?code=${no}`,
});

function demoOrders(phone: string, now: Date): OrderFacts[] {
  const { ago, dayMonth } = clock(now);
  const mine = (order: Omit<OrderFacts, "phones" | "names" | "cancelledAt"> & { cancelledAt?: Date }): OrderFacts => ({
    cancelledAt: null,
    phones: [phone],
    names: [CUSTOMER_NAME],
    ...order,
  });
  const delivered = (id: string, shippedDaysAgo: number, deliveredDaysAgo: number, no: string) =>
    shipment(ago(shippedDaysAgo, "15:10"), [id], { status: "DELIVERED", deliveredAt: ago(deliveredDaysAgo, "11:00"), ...tracking(no) });

  return [
    // MO-9001 ve MO-9002 açıklamadaki sabit tarihlere (25 Eylül, 30 Eylül) bağlı; tarihleri sabit.
    mine({
      name: "#MO-9001",
      createdAt: at("2026-09-12T11:20:00"),
      items: [
        item("demo-1", "10094861484281", "Maius Lavin Etek", "1–36/38 / Siyah", ["1–36/38", "2–40/42", "Kırık Beyaz", "Siyah"], 1, `${PREORDER_SIYAH}\n${CAMPAIGN}\nPoplin kumaştan üretilmektedir.`),
      ],
      shipments: [],
    }),
    mine({
      name: "#MO-9002",
      createdAt: at("2026-09-15T14:05:00"),
      items: [
        item("demo-2", "10246378717433", "Maius Riva Takım", "2–40/42 / Vizon", ["1–36/38", "2–40/42", "Vizon"], 0, `${CAMPAIGN}\nAkıcı dokulu kumaştan iki parçalı takım.`),
      ],
      shipments: [
        shipment(at("2026-09-17T16:00:00"), ["demo-2"], { status: "DELIVERED", deliveredAt: at("2026-09-19T12:30:00"), ...tracking("100200300401") }),
      ],
    }),
    mine({
      name: "#MO-9003",
      createdAt: ago(8, "09:45"),
      items: [
        item("demo-3", "10290984714489", "Maius Cozy Spor Takım", "Koyu Kahve / 2–40/42", ["Vizon", "Koyu Kahve", "1–36/38", "2–40/42", "3–44/46"], 0, "Yumuşak dokulu, esnek spor takım."),
      ],
      shipments: [delivered("demo-3", 6, 4, "100200300402")],
    }),
    mine({
      name: "#MO-9004",
      createdAt: ago(4, "20:30"),
      items: [
        item("demo-4", "10063998058745", "Maius Rosie Body", "1–36/38 / Kemik", ["1–36/38", "2–40/42", "Kemik", "Siyah", "Acı Kahve"], 0, "Esnek dokulu body."),
      ],
      shipments: [shipment(ago(2, "17:40"), ["demo-4"], { status: "CONFIRMED" })],
    }),
    {
      name: "#MO-9005",
      createdAt: ago(2, "10:00"),
      cancelledAt: null,
      phones: [OTHER_PHONE],
      names: [OTHER_NAME],
      items: [
        item("demo-5", "10063997796601", "Maius Top Takım", "1–36/38 / Siyah", ["1–36/38", "2–40/42", "Haki ( Vizon Altton )", "Siyah", "Ekru", "Lacivert"], 1, "Rahat kalıp takım."),
      ],
      shipments: [],
    },
    mine({
      name: "#MO-9006",
      createdAt: ago(1, "10:15"),
      items: [item("demo-6", "demo-mira", "Mira Gömlek", "2–40/42 / Beyaz", ["1–36/38", "2–40/42", "Beyaz", "Mavi"], 1, "Pamuklu gömlek. Stoktan gönderilir.")],
      shipments: [],
    }),
    mine({
      name: "#MO-9007",
      createdAt: ago(3, "13:00"),
      items: [item("demo-7", "demo-nova", "Nova Triko Hırka", "1–36/38 / Ekru", ["1–36/38", "2–40/42", "Ekru", "Gri"], 0, "Yumuşak triko hırka.")],
      shipments: [shipment(ago(2, "16:30"), ["demo-7"], { status: "IN_TRANSIT", ...tracking("100200300407") })],
    }),
    mine({
      name: "#MO-9008",
      createdAt: ago(2, "19:40"),
      items: [
        item("demo-8", "demo-luna", "Luna Kaban", "2–40/42 / Camel", ["1–36/38", "2–40/42", "Camel", "Siyah"], 1, `🕒 ÖN SİPARİŞ: Bu ürün ön sipariştir; siparişler ${dayMonth(12)} tarihinde kargoya teslim edilir.\nYün karışımlı kaban.`),
      ],
      shipments: [],
    }),
    mine({
      name: "#MO-9009",
      createdAt: ago(10, "14:20"),
      cancelledAt: ago(9, "10:05"),
      items: [item("demo-9", "demo-sole", "Sole Pantolon", "1–36/38 / Siyah", ["1–36/38", "2–40/42", "Siyah"], 1, "Yüksek bel kumaş pantolon.")],
      shipments: [],
    }),
    mine({
      name: "#MO-9010",
      createdAt: ago(5, "11:30"),
      items: [
        item("demo-10a", "demo-ada", "Ada Bluz", "1–36/38 / Pudra", ["1–36/38", "2–40/42", "Pudra"], 0, "Saten bluz."),
        item("demo-10b", "demo-eda", "Eda Etek", "1–36/38 / Siyah", ["1–36/38", "2–40/42", "Siyah"], 1, "Midi boy etek."),
      ],
      shipments: [shipment(ago(3, "15:00"), ["demo-10a"], { status: "IN_TRANSIT", ...tracking("100200300410") })],
    }),
    mine({
      name: "#MO-9011",
      createdAt: ago(45, "09:10"),
      items: [item("demo-11", "demo-iris", "İris Elbise", "2–40/42 / Lacivert", ["1–36/38", "2–40/42", "Lacivert"], 0, "Viskon elbise.")],
      shipments: [delivered("demo-11", 43, 40, "100200300411")],
    }),
    mine({
      name: "#MO-9012",
      createdAt: ago(16, "18:00"),
      items: [item("demo-12", "demo-defne", "Defne Ceket", "1–36/38 / Bej", ["1–36/38", "2–40/42", "Bej"], 0, "Astarlı ceket.")],
      shipments: [delivered("demo-12", 14, 12, "100200300412")],
    }),
    mine({
      name: "#MO-9013",
      createdAt: ago(66, "12:40"),
      items: [item("demo-13", "demo-zen", "Zen Takım", "2–40/42 / Haki", ["1–36/38", "2–40/42", "Haki"], 0, "Keten karışımlı takım.")],
      shipments: [delivered("demo-13", 64, 62, "100200300413")],
    }),
    mine({
      name: "#MO-9014",
      createdAt: ago(3, "21:15"),
      items: [item("demo-14", "demo-lina", "Lina Elbise", "1–36/38 / Siyah", ["1–36/38", "2–40/42", "Siyah", "Bej"], 0, "Kruvaze yaka elbise.")],
      shipments: [delivered("demo-14", 2, 1, "100200300414")],
    }),
  ];
}

/**
 * `customerPhone`: o an konuşan test müşterisinin numarası. `now`: tarihlerin kurulduğu an
 * (testlerde sabit, denemede bugün).
 */
export function demoOrderSource(customerPhone: () => string, now: () => Date = () => new Date()): OrderSource {
  return {
    async byName(typed) {
      return demoOrders(customerPhone(), now()).find((o) => sameOrderNumber(o.name, typed)) ?? null;
    },
    async byPhone(phone) {
      return demoOrders(customerPhone(), now())
        .filter((o) => o.phones.includes(phone))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}

/** Deneme siparişlerinin iade talepleri: MO-9012 inceleniyor, MO-9013 onaylandı ama para iadesi 50 gündür yok. */
export function demoReturnsProvider(now: () => Date = () => new Date()): ReturnsProvider {
  return {
    async requestsFor(orderName) {
      const { isoDay } = clock(now());
      const request = (code: string, title: string, variant: string, history: [string, number][]): ReturnRequestInfo => ({
        code,
        type: "REFUND",
        status: history.at(-1)![0],
        createdAt: isoDay(history[0]![1]),
        history: history.map(([status, daysAgo]) => ({ status, at: isoDay(daysAgo) })),
        returnShippingCode: null,
        carrier: null,
        items: [{ title, variant, quantity: 1, action: "REFUND" }],
      });
      if (orderName === "#MO-9012") {
        return [request("IAD-DEMO-12", "Defne Ceket", "1–36/38 / Bej", [["PENDING", 8], ["APPROVED", 7], ["RECEIVED", 3]])];
      }
      if (orderName === "#MO-9013") {
        return [request("IAD-DEMO-13", "Zen Takım", "2–40/42 / Haki", [["PENDING", 56], ["RECEIVED", 50], ["APPROVED", 45]])];
      }
      return [];
    },
  };
}
