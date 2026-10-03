import { and, desc, eq } from "drizzle-orm";
import type { OrderFindings } from "../agents/orders.js";
import type { DB } from "../db/client.js";
import { IMPORTANT_KINDS, NOTIFICATION_KINDS, notifications, type NotificationKind } from "../db/schema.js";
import type { EventBus } from "./events.js";

const MAX_TEXT = 4000;
const REPLY_FAILED = "Lina'nın cevabı WhatsApp'a gönderilemedi; müşteri cevap almadı.";
const union = <T>(a: readonly T[], b: readonly T[]) => [...new Set([...a, ...b])];

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
 * Aynı vaka ekibe bir kez düşer: konuşmada aynı türde açık bildirim varsa yenisi açılmaz, o güncellenir
 * (müşteri aynı konuyu yazdıkça ekibin listesi dolmasın). Ekip tamamladıysa yeni yazışma yeni bildirimdir.
 */
export async function recordOrderNotification(
  deps: { db: DB; events?: EventBus },
  input: { tenantId: string; conversationId: string; findings: OrderFindings; question: string; answer: string; replySent: boolean },
) {
  const classified = classifyFindings(input.findings);
  const { kind, kinds } = classified;
  const issues = input.findings.issues.map((i) => i.text);
  if (!input.replySent) issues.unshift(REPLY_FAILED);
  const important = classified.important || !input.replySent;
  const orderNames = [...input.findings.orders.keys()];
  const answer = input.answer.slice(0, MAX_TEXT);

  const [open] = await deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.conversationId, input.conversationId), eq(notifications.kind, kind), eq(notifications.status, "open")))
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  if (open) {
    const allKinds = new Set(union(open.details.kinds ?? [open.kind], kinds));
    await deps.db
      .update(notifications)
      .set({
        // Önem geri alınmaz: ekip bakana kadar önemli kalır.
        important: open.important || important,
        orderNames: union(open.orderNames, orderNames),
        // Müşterinin bu vakada yazdıkları birikir (en yenisi kalacak şekilde kırpılır); cevap sonuncusudur.
        question: `${open.question}\n${input.question}`.slice(-MAX_TEXT),
        answer,
        details: {
          kinds: NOTIFICATION_KINDS.filter((k) => allKinds.has(k)),
          issues: union((open.details.issues ?? []).filter((i) => i !== REPLY_FAILED), issues),
          ...(input.replySent ? {} : { replyFailed: true }),
        },
      })
      .where(eq(notifications.id, open.id));
    deps.events?.publish(
      input.tenantId,
      !open.important && important
        ? { type: "notification", conversationId: input.conversationId, important }
        : { type: "notification_update", conversationId: input.conversationId },
    );
    return;
  }

  await deps.db.insert(notifications).values({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    kind,
    important,
    orderNames,
    question: input.question.slice(0, MAX_TEXT),
    answer,
    details: { kinds, issues, ...(input.replySent ? {} : { replyFailed: true }) },
  });
  deps.events?.publish(input.tenantId, { type: "notification", conversationId: input.conversationId, important });
}
