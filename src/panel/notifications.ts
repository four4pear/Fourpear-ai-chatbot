import type { NextFunction, Request, Response, Router } from "express";
import { and, asc, count, countDistinct, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { conversations, customers, handoffs, notifications, teamQuestions, users, type MemberRole, type Notification } from "../db/schema.js";
import type { EventBus } from "../core/events.js";
import { formatPhone } from "../lib/phone.js";
import { isUuid, param, type Locals } from "./api.js";
import { awaitingReplyInHuman } from "./queue.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

/** Panelde görünen Türkçe adlar. */
export const NOTIFICATION_LABELS: Record<Notification["kind"], string> = {
  complaint: "Şikayet",
  return_review: "İade: ekip kararı gerekiyor",
  cancel_request: "İptal isteği",
  change_request: "Değişiklik isteği",
  lookup_failed: "Sipariş bilgisine ulaşılamadı",
  delay: "Gecikme",
  no_tracking: "Takip numarası yok",
  daily_limit: "Günlük mesaj sınırı aşıldı",
  verify_locked: "Çok sayıda yanlış doğrulama denemesi",
  order_not_found: "Sipariş bulunamadı",
  team_overdue: "Müşteri cevap bekliyor (soru cevapsız)",
  return_request: "İade/değişim isteği",
  return_status: "İade durumu sorusu",
  unverified: "Doğrulanamayan sipariş sorusu",
  order_question: "Sipariş sorusu",
};

export function toNotificationView(n: Notification, doneByName: string | null = null) {
  return {
    id: n.id,
    conversationId: n.conversationId,
    kind: n.kind,
    label: NOTIFICATION_LABELS[n.kind],
    important: n.important,
    orderNames: n.orderNames,
    question: n.question,
    answer: n.answer,
    issues: n.details.issues ?? [],
    replyFailed: n.details.replyFailed ?? false,
    kinds: (n.details.kinds ?? [n.kind]).map((k) => ({ kind: k, label: NOTIFICATION_LABELS[k] })),
    status: n.status,
    createdAt: n.createdAt,
    /** Aynı vaka için güncellendiyse son güncelleme; "Tamamlandı" bununla gönderilir (bkz. done). */
    updatedAt: n.details.updatedAt ?? null,
    doneAt: n.doneAt,
    doneBy: doneByName ? { name: doneByName } : null,
  };
}

/**
 * Ekibe bildirimler (docs/lina-davranis.md "Ekibe bildirimler"): sipariş konularında konuşma
 * devredilmez; her soru burada listelenir, önemliler ayrıca işaretlidir. Mağazanın bütün ekibi görür.
 */
export function registerNotificationRoutes(
  api: Router,
  deps: { db: DB; events: EventBus; now?: () => Date },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const { db } = deps;
  const member = [guards.requireUser, guards.requireTenant("agent")];

  api.get("/tenants/:tenantId/notifications", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const status = req.query.status === "done" ? "done" : "open";
    const onlyImportant = req.query.filter === "important";

    const rows = await db
      .select({ n: notifications, customer: customers, doneByName: users.name })
      .from(notifications)
      .innerJoin(conversations, eq(conversations.id, notifications.conversationId))
      .innerJoin(customers, eq(customers.id, conversations.customerId))
      .leftJoin(users, eq(users.id, notifications.doneBy))
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.status, status),
          onlyImportant ? eq(notifications.important, true) : undefined,
        ),
      )
      // Açıklar: en uzun bekleyen üstte (diğer bekleyen listeleri gibi; güncellenen eski bildirim de yerinde kalır).
      // Tamamlananlar: en son tamamlanan üstte.
      .orderBy(status === "open" ? asc(notifications.createdAt) : desc(notifications.doneAt))
      .limit(100);

    const [[open], [important]] = await Promise.all([
      db.select({ n: count() }).from(notifications).where(and(eq(notifications.tenantId, tenantId), eq(notifications.status, "open"))),
      db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.tenantId, tenantId), eq(notifications.status, "open"), eq(notifications.important, true))),
    ]);

    res.json({
      status,
      filter: onlyImportant ? "important" : "all",
      counts: { open: open?.n ?? 0, important: important?.n ?? 0 },
      notifications: rows.map(({ n, customer, doneByName }) => ({
        ...toNotificationView(n, doneByName),
        customer: { name: customer.name?.trim() || formatPhone(customer.waId), phone: formatPhone(customer.waId) },
      })),
    });
  });

  api.post("/tenants/:tenantId/notifications/:notificationId/done", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const notificationId = param(req, "notificationId");
    if (!isUuid(notificationId)) return res.status(404).json({ error: "Bildirim bulunamadı" });
    const user = (res.locals as Locals).user!;

    const mine = and(eq(notifications.id, notificationId), eq(notifications.tenantId, tenantId));
    // Ekip kartı okuduktan sonra müşteri yeni bir şey yazdıysa görülmeyen istek kapanmasın:
    // panel, gördüğü hâlin güncelleme zamanını gönderir; değiştiyse önce yeni hâline bakılır.
    if (req.body && "seenUpdatedAt" in req.body) {
      const [current] = await db.select({ details: notifications.details, status: notifications.status }).from(notifications).where(mine);
      if (current?.status === "open" && (current.details.updatedAt ?? null) !== (req.body.seenUpdatedAt ?? null)) {
        return res.status(409).json({ error: "Bu talep siz bakarken güncellendi: müşteri yeni bir şey yazdı. Yeni hâline bakıp tekrar deneyin." });
      }
    }
    // Yalnızca açık olan kapatılır: zaten tamamlanmışsa kimin kapattığı değişmez.
    const [updated] = await db
      .update(notifications)
      .set({ status: "done", doneAt: deps.now?.() ?? new Date(), doneBy: user.id })
      .where(and(mine, eq(notifications.status, "open")))
      .returning({ conversationId: notifications.conversationId });
    if (!updated) {
      const [exists] = await db.select({ id: notifications.id }).from(notifications).where(mine);
      return exists ? res.json({ ok: true }) : res.status(404).json({ error: "Bildirim bulunamadı" });
    }
    deps.events.publish(tenantId, { type: "notification_update", conversationId: updated.conversationId });
    res.json({ ok: true });
  });

  /** Yanlışlıkla "Tamamlandı" denen talep geri açılır. */
  api.post("/tenants/:tenantId/notifications/:notificationId/reopen", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const notificationId = param(req, "notificationId");
    if (!isUuid(notificationId)) return res.status(404).json({ error: "Bildirim bulunamadı" });
    const [updated] = await db
      .update(notifications)
      .set({ status: "open", doneAt: null, doneBy: null })
      .where(and(eq(notifications.id, notificationId), eq(notifications.tenantId, tenantId)))
      .returning({ conversationId: notifications.conversationId });
    if (!updated) return res.status(404).json({ error: "Bildirim bulunamadı" });
    deps.events.publish(tenantId, { type: "notification_update", conversationId: updated.conversationId });
    res.json({ ok: true });
  });

  /**
   * Ekibi bekleyen iş sayıları (menüdeki rozet için): Lina'nın soruları, ekibe iletilen önemli talepler,
   * kimsenin devralmadığı devredilmiş konuşmalar ve ekipteyken müşterinin yeniden yazdığı konuşmalar.
   */
  api.get("/tenants/:tenantId/waiting-count", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const [[questions], [forwarded], [handedOff], pending] = await Promise.all([
      db.select({ n: count() }).from(teamQuestions).where(and(eq(teamQuestions.tenantId, tenantId), eq(teamQuestions.status, "open"))),
      db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.tenantId, tenantId), eq(notifications.status, "open"), eq(notifications.important, true))),
      db
        .select({ n: countDistinct(handoffs.conversationId) })
        .from(handoffs)
        .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
        .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.status, "open"), isNull(conversations.assignedUserId))),
      awaitingReplyInHuman(db, tenantId),
    ]);
    const counts = { questions: questions?.n ?? 0, forwarded: forwarded?.n ?? 0, handoffs: (handedOff?.n ?? 0) + pending.length };
    res.json({ ...counts, total: counts.questions + counts.forwarded + counts.handoffs });
  });
}
