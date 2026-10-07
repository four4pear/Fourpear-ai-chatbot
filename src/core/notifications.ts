import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { OrderFindings } from "../agents/orders.js";
import type { DB } from "../db/client.js";
import { IMPORTANT_KINDS, NOTIFICATION_KINDS, notifications, type NotificationKind } from "../db/schema.js";
import type { EventBus } from "./events.js";

const MAX_TEXT = 4000;
/** Bu kadar yanlış ad soyad denemesinden sonra ad soyadla doğrulama 24 saat kapanır. */
export const MAX_FAILED_IDENTITY = 3;
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
  if (f.identityLocked) kinds.add("verify_locked");
  // Müşteri bilgilerini yazdı ama sipariş bulunamadı: ekip bakar (yazım hatası, farklı ad, eski sipariş...).
  if (f.failedIdentity) kinds.add("order_not_found");
  // Sipariş listesi gösterilip "hangisi?" diye soruldu: sessiz kayıt; asıl bildirim müşteri seçince gelir.
  if (!kinds.size) kinds.add("order_question");
  const sorted = NOTIFICATION_KINDS.filter((k) => kinds.has(k));
  const kind = sorted[0] ?? "order_question";
  return { kind, kinds: sorted, important: (IMPORTANT_KINDS as readonly NotificationKind[]).includes(kind) };
}

const KIND_TEXT: Partial<Record<NotificationKind, string>> = {
  complaint: "şikayet",
  return_review: "iade incelemesi",
  cancel_request: "iptal isteği",
  change_request: "değişiklik isteği",
  lookup_failed: "sipariş bilgisine ulaşılamadı",
  delay: "gecikme",
  no_tracking: "takip numarası yok",
  verify_locked: "çok sayıda yanlış doğrulama denemesi",
  order_not_found: "sipariş bulunamadı",
  team_overdue: "ekip cevabı bekleniyor",
};

/**
 * Uzman cevabının sonuna kodun eklediği kesin kayıt: ekibe önemli bildirim gerçekten açılacak mı?
 * Uzmanın "iletildi" yazısı bir modelin cümlesidir; bildirimi açan, bulgulardır (findings). Lina müşteriye
 * "iletildi/işleme alındı" demeyi bu kayda göre yapar, böylece söz verilen talep ekibe düşmeden kalmaz.
 */
export function systemRecord(f: OrderFindings): string {
  const c = classifyFindings(f);
  const head = "SİSTEM KAYDI (kodun yazdığı kesin bilgidir; uzmanın yazısı bununla çelişirse bu geçerlidir):";
  if (c.important) {
    const labels = c.kinds.filter((k) => (IMPORTANT_KINDS as readonly NotificationKind[]).includes(k)).map((k) => KIND_TEXT[k] ?? k);
    return `${head} ekibe ÖNEMLİ bildirim açılacak (${labels.join(", ")}). Talebin işleme alındığını söyleyebilirsin.`;
  }
  return `${head} ekibe önemli bildirim AÇILMAYACAK; talep ekibe iletilmedi. Müşteriye "iletildi" ya da "işleme alındı" deme.`;
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
  if (input.findings.identityLocked) {
    issues.push(
      `Bu numaradan son 24 saatte ${MAX_FAILED_IDENTITY} kez siparişle eşleşmeyen ad soyad yazıldı; ad soyadla doğrulama 24 saat kapatıldı. Müşteriye sipariş bilgisi verilmedi. Gerçek bir müşteri olabilir: konuşmaya bakın.`,
    );
  }
  if (!input.replySent) issues.unshift(REPLY_FAILED);
  const important = classified.important || !input.replySent;
  const orderNames = [...input.findings.orders.keys()];
  const failedIdentity = input.findings.failedIdentity ? 1 : 0;
  if (failedIdentity) {
    issues.push("Müşterinin yazdığı bilgilerle (sipariş numarası, ad soyad ya da telefon) sipariş bulunamadı. Yazım hatası, farklı ad ya da eski sipariş olabilir: konuşmaya bakıp gerekirse devralıp müşteriye yazın.");
  }
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
            ...((open.details.failedIdentity ?? 0) + failedIdentity ? { failedIdentity: (open.details.failedIdentity ?? 0) + failedIdentity } : {}),
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
    details: { kinds, issues, ...(input.replySent ? {} : { replyFailed: true }), ...(failedIdentity ? { failedIdentity } : {}) },
  });
  deps.events?.publish(input.tenantId, { type: "notification", conversationId: input.conversationId, important });
}

/**
 * Son 24 saatte bu konuşmada kaç kez siparişle eşleşmeyen ad soyad yazıldı? Sınıra ulaşınca ad soyadla
 * doğrulama kapanır: sipariş numaraları sıralı olduğu için, numaraları farklı isimlerle denemek mümkün olmasın.
 */
export async function identityLocked(db: DB, conversationId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum((${notifications.details}->>'failedIdentity')::int), 0)`.mapWith(Number) })
    .from(notifications)
    .where(and(eq(notifications.conversationId, conversationId), gte(notifications.createdAt, since)));
  return (row?.n ?? 0) >= MAX_FAILED_IDENTITY;
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
