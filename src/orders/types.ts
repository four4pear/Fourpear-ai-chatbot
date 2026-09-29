import { normalizePhone } from "../lib/phone.js";

/**
 * Siparişin Lina için gereken kısmı. Tutar, ödeme ve adres hiç çekilmez
 * (docs/lina-davranis.md "Paylaşılan bilgiler"); telefonlar yalnızca sahiplik doğrulaması içindir.
 */
export type OrderItem = {
  id: string;
  /** Shopify ürün kimliği (sayı); kampanya arşivindeki kayıtla eşleşir. */
  productId: string | null;
  title: string;
  variantTitle: string | null;
  options: { name: string; value: string }[];
  /** Ürünün bütün seçenek değerleri (ör. Siyah, Kırık Beyaz): ön sipariş hangi varyantı kapsıyor? */
  productOptionValues: string[];
  /** Güncel adet (iade edilen ve çıkarılanlar hariç). */
  quantity: number;
  /** Henüz kargoya verilmemiş adet. */
  unfulfilled: number;
  /** Ürünün bugünkü açıklaması (düz metin); arşivde kayıt yoksa kullanılır. */
  currentDescription: string | null;
};

export type Shipment = {
  createdAt: Date;
  /** Shopify gösterim durumu, ör. IN_TRANSIT, DELIVERED */
  status: string;
  deliveredAt: Date | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  itemIds: string[];
  /** Kargoyla gönderilen ürün var mı? (Dijital üründe takip numarası beklenmez.) */
  requiresShipping: boolean;
};

export type OrderFacts = {
  /** "#MO-1271" */
  name: string;
  createdAt: Date;
  cancelledAt: Date | null;
  /** Normalleştirilmiş telefonlar (sipariş, müşteri, teslimat, fatura); modele ve müşteriye gösterilmez. */
  phones: string[];
  items: OrderItem[];
  shipments: Shipment[];
};

/** Mağazanın siparişleri: Shopify ya da testte/simülatörde sahte kaynak. */
export interface OrderSource {
  /** Sipariş numarasıyla (#MO-1271, MO-1271, 1271). */
  byName(name: string): Promise<OrderFacts | null>;
  /** Bu telefona ait olabilecek son siparişler; sahiplik ayrıca doğrulanır. */
  byPhone(phone: string): Promise<OrderFacts[]>;
}

/** Sipariş müşterinin WhatsApp numarasına mı ait? (Sipariş bilgisi yalnızca o zaman paylaşılır.) */
export function belongsTo(order: OrderFacts, waId: string): boolean {
  const wa = normalizePhone(waId);
  return wa.length >= 10 && order.phones.some((p) => p === wa);
}

/** Müşterinin yazdığı numara bu sipariş mi? "mo 1271", "#1271" → "#MO-1271" */
export function sameOrderNumber(orderName: string, typed: string): boolean {
  const typedDigits = typed.match(/\d+/g)?.join("");
  if (!typedDigits) return false;
  const groups: string[] = orderName.match(/\d+/g) ?? [];
  return groups.includes(typedDigits) || groups.join("") === typedDigits;
}
