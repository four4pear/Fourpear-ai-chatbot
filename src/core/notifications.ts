import { and, desc, eq, gte } from "drizzle-orm";
import type { OrderFindings } from "../agents/orders.js";
import type { DB } from "../db/client.js";
import { IMPORTANT_KINDS, NOTIFICATION_KINDS, notifications, type NotificationKind } from "../db/schema.js";
import type { EventBus } from "./events.js";

const MAX_TEXT = 4000;
const REPLY_FAILED = "Lina'nın cevabı WhatsApp'a gönderilemedi; müşteri cevap almadı.";
const REPLY_FAILED_EARLIER = "Daha önce bir cevap WhatsApp'a gönderilemedi; sonraki cevap gönderildi.";
const union = <T>(a: readonly T[], b: readonly T[]) => [...new Set([...a, ...b])];
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

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
 *
 * Aynı vaka ekibe bir kez düşer: konuşmada aynı türde ve AYNI SİPARİŞLER için açık önemli bildirim varsa
 * yenisi açılmaz, o güncellenir (müşteri aynı konuyu yazdıkça ekibin listesi dolmasın). Başka bir sipariş,
 * başka bir tür ya da ekibin tamamladığı bir bildirimden sonraki yazışma yeni bildirimdir. Sessiz kayıtlar
 * birleştirilmez: ekip onları kapatmadığı için birikip durmasın, her soru ayrı kayıt kalır.
 */
export async function recordOrderNotification(
  deps: { db: DB; events?: EventBus; now?: () => Date },
  input: { tenantId: string; conversationId: string; findings: OrderFindings; question: string; answer: string; replySent: boolean },
) {
  const classified = classifyFindings(input.findings);
  const { kind, kinds } = classified;
  const issues = input.findings.issues.map((i) => i.text);
  // Ad soyadla doğrulanan siparişte yazan kişi siparişin sahibi olmayabilir: ekip işlemden önce teyit etsin.
  const byName = [...input.findings.orders].filter(([, o]) => o.byName).map(([name]) => name);
  if (byName.length) issues.push(`${byName.join(", ")}: WhatsApp numarası siparişteki numara değil; sipariş, müşterinin yazdığı ad soyadla doğrulandı. İptal ya da değişiklik yapmadan önce müşteriyi teyit edin.`);
  if (!input.replySent) issues.unshift(REPLY_FAILED);
  const important = classified.important || !input.replySent;
  const orderNames = [...input.findings.orders.keys()];
  const answer = input.answer.slice(0, MAX_TEXT);

  if (important) {
    const candidates = await deps.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.conversationId, input.conversationId),
          eq(notifications.kind, kind),
          eq(notifications.status, "open"),
          eq(notifications.important, true),
        ),
      )
      .orderBy(desc(notifications.createdAt));
    const open = candidates.find((n) => sameSet(n.orderNames, orderNames));
    if (open) {
      const allKinds = new Set(union(open.details.kinds ?? [open.kind], kinds));
      // Önceki cevap gönderilememiş, bu gönderilmişse sebep kartta kalsın (bildirim önemli kalıyor).
      const earlier = (open.details.issues ?? []).map((i) => (i === REPLY_FAILED && input.replySent ? REPLY_FAILED_EARLIER : i));
      // Ekip tam bu sırada tamamladıysa kapalı bildirime yazılmaz; aşağıda yenisi açılır.
      const updated = await deps.db
        .update(notifications)
        .set({
          // Müşterinin bu vakada yazdıkları birikir (en yenisi kalacak şekilde kırpılır); cevap sonuncusudur.
          question: `${open.question}\n${input.question}`.slice(-MAX_TEXT),
          answer,
          details: {
            kinds: NOTIFICATION_KINDS.filter((k) => allKinds.has(k)),
            issues: union(earlier, issues),
            ...(input.replySent ? {} : { replyFailed: true }),
            updatedAt: (deps.now?.() ?? new Date()).toISOString(),
            updates: (open.details.updates ?? 0) + 1,
          },
        })
        .where(and(eq(notifications.id, open.id), eq(notifications.status, "open")))
        .returning({ id: notifications.id });
      if (updated.length) {
        deps.events?.publish(input.tenantId, { type: "notification_update", conversationId: input.conversationId });
        return;
      }
    }
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

/**
 * Müşteri günlük mesaj sınırını aştı (docs/lina-davranis.md §9): Lina o gün yeni cevap hazırlamaz ve
 * müşteriye bir şey yazılmaz; ekip konuşmayı "Ekibe iletilenler"de görür. Günde bir bildirim: bugün açılmış
 * açık bildirim varsa yenisi açılmaz (dünkü hâlâ açıksa bugün için ayrıca açılır).
 */
export async function recordLimitNotification(
  deps: { db: DB; events?: EventBus },
  input: { tenantId: string; conversationId: string; limit: number; lastMessage: string; now: Date; since: Date },
) {
  const [open] = await deps.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.conversationId, input.conversationId),
        eq(notifications.kind, "daily_limit"),
        eq(notifications.status, "open"),
        gte(notifications.createdAt, input.since),
      ),
    )
    .limit(1);
  if (open) return;
  await deps.db.insert(notifications).values({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    kind: "daily_limit",
    important: true,
    question: input.lastMessage.slice(0, MAX_TEXT),
    answer: "",
    details: {
      kinds: ["daily_limit"],
      issues: [`Müşteri bugün ${input.limit} mesajı aştı. Lina bugün bu müşteriye yeni cevap hazırlamıyor; müşteriye bilgi verilmedi. Yarın kendiliğinden devam eder.`],
    },
    createdAt: input.now,
  });
  deps.events?.publish(input.tenantId, { type: "notification", conversationId: input.conversationId, important: true });
}
