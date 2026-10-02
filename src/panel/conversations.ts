import type { NextFunction, Request, Response, Router } from "express";
import { and, asc, count, countDistinct, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  agentRuns,
  conversations,
  customers,
  handoffs,
  media,
  messages,
  notifications,
  tenants,
  users,
  type Customer,
  type MemberRole,
} from "../db/schema.js";
import { toNotificationView } from "./notifications.js";
import { roleIn, userForSession } from "../auth/service.js";
import { deliverText, waTargetFor } from "../core/conversation.js";
import type { EventBus } from "../core/events.js";
import { formatPhone } from "../lib/phone.js";
import type { WhatsAppSender } from "../whatsapp/client.js";
import { isUuid, param, type Locals } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

type Deps = {
  db: DB;
  wa: WhatsAppSender;
  masterKey: string;
  events: EventBus;
  log: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
  heartbeatMs?: number;
  cancelPendingReply?: (conversationId: string) => void;
};

/** WhatsApp kuralı: müşterinin son mesajından sonra 24 saat serbest mesaj gönderilebilir. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REPLY_CHARS = 4000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Müşterinin panelde görünen adı. Shopify'daki ad sipariş ajanıyla eklenecek (docs/panel.md). */
const displayName = (c: Pick<Customer, "name" | "waId">) => c.name?.trim() || formatPhone(c.waId);

const who = (res: Response) => {
  const l = res.locals as Locals;
  return { user: l.user!, role: l.role as MemberRole };
};

export function registerConversationRoutes(
  api: Router,
  deps: Deps,
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const member = [guards.requireUser, guards.requireTenant("agent")];

  /** Konuşma bu mağazanın mı? Değilse (ya da kimlik geçersizse) null: başka mağazanın verisine erişilemez. */
  async function findConversation(tenantId: string, conversationId: string) {
    if (!isUuid(conversationId)) return null;
    const [row] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
    return row ?? null;
  }

  const notFound = (res: Response) => res.status(404).json({ error: "Konuşma bulunamadı" });

  // ---------------------------------------------------------------------------
  // Liste: bekleyen (açık devir), bende (benim devraldıklarım), tümü

  api.get("/tenants/:tenantId/conversations", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const { user } = who(res);
    const view = req.query.view === "mine" || req.query.view === "all" ? req.query.view : "waiting";

    type Row = {
      c: typeof conversations.$inferSelect;
      customer: Customer;
      assignee: { id: string; name: string } | null;
    };
    let rows: Row[];
    if (view === "waiting") {
      // Kimsenin devralmadığı en uzun bekleyen üstte; devralınmışlar altta.
      rows = await db
        .select({ c: conversations, customer: customers, assignee: { id: users.id, name: users.name } })
        .from(handoffs)
        .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
        .innerJoin(customers, eq(customers.id, conversations.customerId))
        .leftJoin(users, eq(users.id, conversations.assignedUserId))
        .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.status, "open")))
        .orderBy(sql`${conversations.assignedUserId} is not null`, asc(handoffs.createdAt))
        .limit(100);
      rows = rows.filter((r, i) => rows.findIndex((x) => x.c.id === r.c.id) === i);
    } else {
      const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
      rows = await db
        .select({ c: conversations, customer: customers, assignee: { id: users.id, name: users.name } })
        .from(conversations)
        .innerJoin(customers, eq(customers.id, conversations.customerId))
        .leftJoin(users, eq(users.id, conversations.assignedUserId))
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            view === "mine" ? eq(conversations.assignedUserId, user.id) : undefined,
            before && !Number.isNaN(before.getTime()) ? lt(conversations.updatedAt, before) : undefined,
          ),
        )
        .orderBy(desc(conversations.updatedAt))
        .limit(50);
    }

    const ids = rows.map((r) => r.c.id);
    const [openHandoffs, lastMessages] = ids.length
      ? await Promise.all([
          db
            .select()
            .from(handoffs)
            .where(and(inArray(handoffs.conversationId, ids), eq(handoffs.status, "open"))),
          db
            .selectDistinctOn([messages.conversationId], {
              conversationId: messages.conversationId,
              sender: messages.sender,
              type: messages.type,
              text: messages.text,
              createdAt: messages.createdAt,
            })
            .from(messages)
            .where(and(inArray(messages.conversationId, ids), ne(messages.type, "note")))
            .orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.seq)),
        ])
      : [[], []];

    const [[waiting], [mine]] = await Promise.all([
      db
        .select({ n: countDistinct(handoffs.conversationId) })
        .from(handoffs)
        .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
        .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.status, "open"), isNull(conversations.assignedUserId))),
      db
        .select({ n: count() })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.assignedUserId, user.id))),
    ]);

    res.json({
      view,
      counts: { waiting: waiting?.n ?? 0, mine: mine?.n ?? 0 },
      conversations: rows.map(({ c, customer, assignee }) => {
        const h = openHandoffs.find((x) => x.conversationId === c.id);
        const m = lastMessages.find((x) => x.conversationId === c.id);
        return {
          id: c.id,
          status: c.status,
          updatedAt: c.updatedAt,
          customer: { name: displayName(customer), phone: formatPhone(customer.waId) },
          assignedTo: assignee?.id ? assignee : null,
          openHandoff: h ? { reason: h.reason, summary: h.summary, createdAt: h.createdAt } : null,
          lastMessage: m ? { sender: m.sender, type: m.type, text: m.text, createdAt: m.createdAt } : null,
        };
      }),
    });
  });

  // ---------------------------------------------------------------------------
  // Ayrıntı: mesajlar, Lina'nın uzmanlara sordukları, devirler, 24 saat penceresi

  api.get("/tenants/:tenantId/conversations/:conversationId", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const c = await findConversation(tenantId, param(req, "conversationId"));
    if (!c) return notFound(res);
    const { user } = who(res);

    const [[customer], [assignee], msgRows, runs, handoffRows, notificationRows] = await Promise.all([
      db.select().from(customers).where(eq(customers.id, c.customerId)),
      c.assignedUserId
        ? db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, c.assignedUserId))
        : Promise.resolve([]),
      db
        .select({ m: messages, authorName: users.name, mediaId: media.id })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorUserId))
        .leftJoin(media, eq(media.messageId, messages.id))
        .where(eq(messages.conversationId, c.id))
        .orderBy(desc(messages.createdAt), desc(messages.seq))
        .limit(200),
      db
        .select({ agent: agentRuns.agent, question: agentRuns.input, answer: agentRuns.output, createdAt: agentRuns.createdAt })
        .from(agentRuns)
        .where(and(eq(agentRuns.conversationId, c.id), ne(agentRuns.agent, "lina")))
        .orderBy(desc(agentRuns.createdAt))
        .limit(50),
      db.select().from(handoffs).where(eq(handoffs.conversationId, c.id)).orderBy(desc(handoffs.createdAt)).limit(20),
      db
        .select({ n: notifications, doneByName: users.name })
        .from(notifications)
        .leftJoin(users, eq(users.id, notifications.doneBy))
        .where(eq(notifications.conversationId, c.id))
        .orderBy(desc(notifications.createdAt))
        .limit(20),
    ]);

    const windowOpenUntil = c.lastCustomerMessageAt ? new Date(c.lastCustomerMessageAt.getTime() + REPLY_WINDOW_MS) : null;
    const windowOpen = windowOpenUntil !== null && windowOpenUntil > now();

    res.json({
      conversation: {
        id: c.id,
        status: c.status,
        assignedTo: assignee ?? null,
        assignedAt: c.assignedAt,
        lastCustomerMessageAt: c.lastCustomerMessageAt,
        windowOpenUntil,
        canReply: c.status === "human" && c.assignedUserId === user.id && windowOpen,
      },
      customer: { name: displayName(customer!), phone: formatPhone(customer!.waId), firstSeenAt: customer!.createdAt },
      messages: msgRows.reverse().map(({ m, authorName, mediaId }) => ({
        id: m.id,
        sender: m.sender,
        type: m.type,
        text: m.text,
        createdAt: m.createdAt,
        author: authorName ? { name: authorName } : null,
        hasImage: Boolean(mediaId),
        sendError: (m.meta as { sendError?: string } | null)?.sendError ?? null,
      })),
      expertCalls: runs.reverse(),
      handoffs: handoffRows.map((h) => ({
        reason: h.reason,
        summary: h.summary,
        status: h.status,
        createdAt: h.createdAt,
        resolvedAt: h.resolvedAt,
      })),
      notifications: notificationRows.map(({ n, doneByName }) => toNotificationView(n, doneByName)),
    });
  });

  // ---------------------------------------------------------------------------
  // Devral: ilk tıklayan alır; başkasının devraldığını sadece mağaza sahibi alabilir.

  api.post("/tenants/:tenantId/conversations/:conversationId/takeover", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const conversationId = param(req, "conversationId");
    const { user, role } = who(res);
    if (!isUuid(conversationId)) return notFound(res);

    const outcome = await db.transaction(async (tx) => {
      const [c] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
        .for("update");
      if (!c) return { status: 404 as const };
      if (c.status === "human" && c.assignedUserId === user.id) return { status: 200 as const };

      let previous: string | null = null;
      if (c.assignedUserId && c.assignedUserId !== user.id) {
        const [p] = await tx.select({ name: users.name }).from(users).where(eq(users.id, c.assignedUserId));
        previous = p?.name ?? null;
        if (role !== "owner") return { status: 409 as const, holder: previous };
      }

      const at = now();
      await tx
        .update(conversations)
        .set({ status: "human", assignedUserId: user.id, assignedAt: at, updatedAt: at })
        .where(eq(conversations.id, c.id));
      await tx.insert(messages).values({
        tenantId,
        conversationId: c.id,
        sender: "system",
        type: "note",
        text: previous ? `${user.name} konuşmayı devraldı (önceki: ${previous})` : `${user.name} konuşmayı devraldı`,
      });
      return { status: 200 as const };
    });

    if (outcome.status === 404) return notFound(res);
    if (outcome.status === 409) {
      return res.status(409).json({ error: `Bu konuşmayı ${outcome.holder ?? "başka bir ekip üyesi"} devraldı.` });
    }
    // Lina'nın bekleyen ya da hazırlanan cevabı iptal: ekip ile Lina aynı anda yazmasın.
    deps.cancelPendingReply?.(conversationId);
    deps.events.publish(tenantId, { type: "conversation", conversationId });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Bota geri ver: açık devirler çözülür, Lina yeniden cevap verir.

  api.post("/tenants/:tenantId/conversations/:conversationId/release", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const c = await findConversation(tenantId, param(req, "conversationId"));
    if (!c) return notFound(res);
    const { user, role } = who(res);
    if (c.assignedUserId && c.assignedUserId !== user.id && role !== "owner") {
      return res.status(403).json({ error: "Bu konuşmayı devralan kişi ya da mağaza sahibi bota geri verebilir." });
    }

    const [tenant] = await db.select({ botName: tenants.botName }).from(tenants).where(eq(tenants.id, tenantId));
    const at = now();
    await db.transaction(async (tx) => {
      await tx
        .update(conversations)
        .set({ status: "bot", assignedUserId: null, assignedAt: null, updatedAt: at })
        .where(eq(conversations.id, c.id));
      await tx
        .update(handoffs)
        .set({ status: "resolved", resolvedAt: at, resolvedBy: user.id })
        .where(and(eq(handoffs.conversationId, c.id), eq(handoffs.status, "open")));
      await tx.insert(messages).values({
        tenantId,
        conversationId: c.id,
        sender: "system",
        type: "note",
        text: `${user.name} konuşmayı ${tenant?.botName ?? "Lina"}'ya geri verdi`,
      });
    });
    deps.events.publish(tenantId, { type: "conversation", conversationId: c.id });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Cevap gönder: sadece devralan kişi, sadece 24 saat penceresi içinde.

  api.post("/tenants/:tenantId/conversations/:conversationId/messages", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const c = await findConversation(tenantId, param(req, "conversationId"));
    if (!c) return notFound(res);
    const { user } = who(res);

    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "Mesaj boş olamaz." });
    if (text.length > MAX_REPLY_CHARS) {
      return res.status(400).json({ error: `Mesaj en fazla ${MAX_REPLY_CHARS} karakter olabilir.` });
    }
    if (c.status !== "human" || c.assignedUserId !== user.id) {
      return res.status(409).json({ error: "Cevap yazmak için önce konuşmayı devralın." });
    }
    if (!c.lastCustomerMessageAt || now().getTime() - c.lastCustomerMessageAt.getTime() > REPLY_WINDOW_MS) {
      return res.status(422).json({
        error: "Müşterinin son mesajından 24 saat geçti. WhatsApp kuralı gereği müşteri yeniden yazana kadar mesaj gönderilemez.",
      });
    }

    const wa = await waTargetFor(db, deps.masterKey, c.id);
    const result = await deliverText(deps, { tenantId, conversationId: c.id, wa, text, sender: "agent", authorUserId: user.id });
    await db.update(conversations).set({ updatedAt: now() }).where(eq(conversations.id, c.id));
    if (!result.sent) {
      return res.status(502).json({ error: "Mesaj WhatsApp'a gönderilemedi. Lütfen tekrar deneyin.", messageId: result.messageId });
    }
    res.json({ messageId: result.messageId });
  });

  // ---------------------------------------------------------------------------
  // Müşterinin fotoğrafı: yalnızca o mağazanın ekibine.

  api.get("/tenants/:tenantId/media/:messageId", ...member, async (req, res) => {
    const tenantId = param(req, "tenantId");
    const messageId = param(req, "messageId");
    if (!isUuid(messageId)) return res.status(404).json({ error: "Bulunamadı" });
    const [m] = await db
      .select()
      .from(media)
      .where(and(eq(media.messageId, messageId), eq(media.tenantId, tenantId)));
    if (!m) return res.status(404).json({ error: "Bulunamadı" });

    // Görsel dışı bir şey tarayıcıda çalıştırılmasın: indirme olarak verilir.
    const safeImage = IMAGE_TYPES.has(m.mimeType);
    res.set({
      "Content-Type": safeImage ? m.mimeType : "application/octet-stream",
      "Content-Disposition": safeImage ? "inline" : "attachment",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.send(m.data);
  });

  // ---------------------------------------------------------------------------
  // Canlı güncelleme (Server-Sent Events). Olaylarda yalnızca konuşma kimliği var.

  api.get("/tenants/:tenantId/events", ...member, (req, res) => {
    const tenantId = param(req, "tenantId");
    const { user } = who(res);
    const sessionToken = (res.locals as Locals).sessionToken!;

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 3000\n\n");

    const unsubscribe = deps.events.subscribe(tenantId, (e) => {
      const data = e.type === "notification" ? { conversationId: e.conversationId, important: e.important } : { conversationId: e.conversationId };
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    // Oturum kapandıysa (çıkış, şifre değişimi) ya da mağazadan çıkarıldıysa akış kesilir.
    const heartbeat = setInterval(async () => {
      try {
        const current = await userForSession(db, sessionToken);
        if (!current || !(await roleIn(db, current, tenantId))) return res.end();
        res.write(": ping\n\n");
      } catch {
        res.end();
      }
    }, deps.heartbeatMs ?? 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    void user;
  });
}
