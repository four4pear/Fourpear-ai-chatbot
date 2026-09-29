import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { integrations } from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import { kolayIadeProvider } from "./kolay-iade.js";

/**
 * Mağazanın iade sistemi (docs/lina-davranis.md "İade sistemi bağlantısı"): yalnızca okuma.
 * Lina'ya sadece müşteriye söylenebilecek alanlar gelir; müşteri kişisel bilgisi, IBAN/ödeme
 * ve ekibin iç notları hiç gelmez.
 */
export type ReturnRequestInfo = {
  code: string | null;
  /** REFUND (para iadesi) | EXCHANGE (değişim) */
  type: string | null;
  /** PENDING | APPROVED | RECEIVED | REFUNDED | REJECTED | CANCELLED */
  status: string | null;
  createdAt: string | null;
  history: { status: string | null; at: string | null }[];
  /** İade kargo kodu (müşteri ürünü bu kodla gönderir). */
  returnShippingCode: string | null;
  carrier: string | null;
  items: { title: string | null; variant: string | null; quantity: number | null; action: string | null }[];
};

export interface ReturnsProvider {
  /** Siparişe ait iade/değişim talepleri; yoksa boş liste. */
  requestsFor(orderName: string): Promise<ReturnRequestInfo[]>;
}

/** Talep durumlarının Türkçe karşılıkları (panelin müşteri metinleri gelince güncellenecek). */
export const RETURN_STATUS_LABELS: Record<string, string> = {
  PENDING: "talep alındı, inceleniyor",
  APPROVED: "talep onaylandı",
  RECEIVED: "ürün depoya ulaştı",
  REFUNDED: "iade tamamlandı",
  REJECTED: "talep reddedildi",
  CANCELLED: "talep iptal edildi",
};

export type ReturnsConfig = { url: string; store: string };

/** Mağazanın açık iade sistemi bağlantısı; yoksa null. */
export async function returnsProviderFor(db: DB, masterKey: string, tenantId: string): Promise<ReturnsProvider | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.kind, "returns_mcp"), eq(integrations.enabled, true)));
  if (!row?.secretEnc || !row.config.url || !row.config.store) return null;
  return kolayIadeProvider({ url: row.config.url, store: row.config.store, key: decryptSecret(row.secretEnc, masterKey) });
}
