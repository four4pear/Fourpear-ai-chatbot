import type { OrderFindings } from "../agents/orders.js";
import type { DB } from "../db/client.js";
import { IMPORTANT_KINDS, NOTIFICATION_KINDS, notifications, type NotificationKind } from "../db/schema.js";
import type { EventBus } from "./events.js";

const MAX_TEXT = 4000;

/**
 * Sipariş uzmanının bulduklarından bildirimin türü (docs/lina-davranis.md "Ekibe bildirimler").
 * - İptal isteği yalnızca kargoya verilmemiş ürün varsa önemlidir; kargodaysa kayıttır.
 * - Doğrulanmış sipariş yoksa yalnızca şikayet önemlidir; diğerleri "doğrulanamadı" kaydıdır
 *   (ekip, kimin olduğu belli olmayan bir siparişte işlem yapamaz).
 */
export function classifyFindings(f: OrderFindings): { kind: NotificationKind; kinds: NotificationKind[]; important: boolean } {
  const kinds = new Set<NotificationKind>();
  const verified = f.orders.size > 0;
  const unshipped = [...f.orders.values()].some((o) => o.unshipped);
  for (const topic of f.topics) {
    if (topic === "complaint") kinds.add("complaint");
    else if (!verified) continue;
    else if (topic === "cancel") kinds.add(unshipped ? "cancel_request" : "order_question");
    else if (topic === "change") kinds.add("change_request");
    else if (topic === "return") kinds.add("return_request");
    else if (topic === "return_status") kinds.add("return_status");
    else kinds.add("order_question");
  }
  for (const issue of f.issues) kinds.add(issue.kind);
  // Sipariş sistemine ulaşılamadı: iptal/değişiklik gibi istekler doğrulanamadı diye sessiz kalmasın.
  if (f.lookupFailed && !verified) kinds.add("lookup_failed");
  if (f.unverified) kinds.add("unverified");
  // Sipariş listesi gösterilip "hangisi?" diye soruldu: sessiz kayıt; asıl bildirim müşteri seçince gelir.
  if (!kinds.size) kinds.add("order_question");
  const sorted = NOTIFICATION_KINDS.filter((k) => kinds.has(k));
  const kind = sorted[0] ?? "order_question";
  return { kind, kinds: sorted, important: (IMPORTANT_KINDS as readonly NotificationKind[]).includes(kind) };
}

/**
 * Cevap hazırlandıktan sonra: sipariş konusundaki bildirimi kaydeder ve panele haber verir.
 * Cevap WhatsApp'a gönderilemediyse müşteri cevapsız kalmıştır: bildirim her durumda önemlidir.
 */
export async function recordOrderNotification(
  deps: { db: DB; events?: EventBus },
  input: { tenantId: string; conversationId: string; findings: OrderFindings; question: string; answer: string; replySent: boolean },
) {
  const classified = classifyFindings(input.findings);
  const { kind, kinds } = classified;
  const issues = input.findings.issues.map((i) => i.text);
  if (!input.replySent) issues.unshift("Lina'nın cevabı WhatsApp'a gönderilemedi; müşteri cevap almadı.");
  const important = classified.important || !input.replySent;
  await deps.db.insert(notifications).values({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    kind,
    important,
    orderNames: [...input.findings.orders.keys()],
    question: input.question.slice(0, MAX_TEXT),
    answer: input.answer.slice(0, MAX_TEXT),
    details: { kinds, issues, ...(input.replySent ? {} : { replyFailed: true }) },
  });
  deps.events?.publish(input.tenantId, { type: "notification", conversationId: input.conversationId, important });
}
