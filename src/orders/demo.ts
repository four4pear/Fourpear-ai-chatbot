import { sameOrderNumber, type OrderFacts, type OrderItem, type OrderSource, type Shipment } from "./types.js";

/**
 * Simülatör için deneme siparişleri (`npm run chat -- --demo-siparis`). MAIUS'un gerçek ürünleriyle
 * uydurma siparişlerdir; gerçek müşteri verisi yoktur. Ürün açıklamaları kampanya arşivinden okunur.
 * Siparişler o an konuşan simülatör müşterisine aittir; #MO-9005 başka bir numaraya aittir.
 */
export const DEMO_ORDERS_HELP = [
  "#MO-9001  ön sipariş gecikmesi (Lavin Etek, Siyah)",
  "#MO-9002  kampanyalı ürün, teslim edildi (Riva Takım)",
  "#MO-9003  kampanyasız ürün, teslim edildi (Cozy Spor Takım)",
  "#MO-9004  kargoya verildi ama takip numarası yok (Rosie Body)",
  "#MO-9005  başka bir numaranın siparişi (doğrulanamaz)",
];

const OTHER_PHONE = "905559999999";
const at = (iso: string) => new Date(`${iso}+03:00`);

function item(id: string, productId: string, title: string, variantTitle: string, optionValues: string[], unfulfilled: number): OrderItem {
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
    currentDescription: null,
  };
}

function shipment(createdAt: string, itemIds: string[], opts: Partial<Shipment> = {}): Shipment {
  return {
    createdAt: at(createdAt),
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

function demoOrders(phone: string): OrderFacts[] {
  const tracking = (no: string) => ({
    trackingNumber: no,
    trackingUrl: `https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula?code=${no}`,
  });
  return [
    {
      name: "#MO-9001",
      createdAt: at("2026-09-12T11:20:00"),
      cancelledAt: null,
      phones: [phone],
      items: [item("demo-1", "10094861484281", "Maius Lavin Etek", "1–36/38 / Siyah", ["1–36/38", "2–40/42", "Kırık Beyaz", "Siyah"], 1)],
      shipments: [],
    },
    {
      name: "#MO-9002",
      createdAt: at("2026-09-15T14:05:00"),
      cancelledAt: null,
      phones: [phone],
      items: [item("demo-2", "10246378717433", "Maius Riva Takım", "2–40/42 / Vizon", ["1–36/38", "2–40/42", "Vizon"], 0)],
      shipments: [
        shipment("2026-09-17T16:00:00", ["demo-2"], { status: "DELIVERED", deliveredAt: at("2026-09-19T12:30:00"), ...tracking("100200300401") }),
      ],
    },
    {
      name: "#MO-9003",
      createdAt: at("2026-09-20T09:45:00"),
      cancelledAt: null,
      phones: [phone],
      items: [
        item("demo-3", "10290984714489", "Maius Cozy Spor Takım", "Koyu Kahve / 2–40/42", ["Vizon", "Koyu Kahve", "1–36/38", "2–40/42", "3–44/46"], 0),
      ],
      shipments: [
        shipment("2026-09-22T15:10:00", ["demo-3"], { status: "DELIVERED", deliveredAt: at("2026-09-24T11:00:00"), ...tracking("100200300402") }),
      ],
    },
    {
      name: "#MO-9004",
      createdAt: at("2026-09-24T20:30:00"),
      cancelledAt: null,
      phones: [phone],
      items: [item("demo-4", "10063998058745", "Maius Rosie Body", "1–36/38 / Kemik", ["1–36/38", "2–40/42", "Kemik", "Siyah", "Acı Kahve"], 0)],
      shipments: [shipment("2026-09-26T17:40:00", ["demo-4"], { status: "CONFIRMED" })],
    },
    {
      name: "#MO-9005",
      createdAt: at("2026-09-26T10:00:00"),
      cancelledAt: null,
      phones: [OTHER_PHONE],
      items: [
        item("demo-5", "10063997796601", "Maius Top Takım", "1–36/38 / Siyah", ["1–36/38", "2–40/42", "Haki ( Vizon Altton )", "Siyah", "Ekru", "Lacivert"], 1),
      ],
      shipments: [],
    },
  ];
}

/** `customerPhone`: o an konuşan simülatör müşterisinin numarası. */
export function demoOrderSource(customerPhone: () => string): OrderSource {
  return {
    async byName(typed) {
      return demoOrders(customerPhone()).find((o) => sameOrderNumber(o.name, typed)) ?? null;
    },
    async byPhone(phone) {
      return demoOrders(customerPhone())
        .filter((o) => o.phones.includes(phone))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}
