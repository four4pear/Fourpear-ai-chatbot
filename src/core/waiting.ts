import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { businessStatus } from "./business-hours.js";
import type { EventBus } from "./events.js";
import type { DB } from "../db/client.js";
import { conversations, handoffs, messages, notifications, resolveSettings, type Tenant } from "../db/schema.js";
import { awaitingReplyInHuman } from "../panel/queue.js";

/** Ekibin dönüşünü bekleyen müşteri için hatırlatma süresi (ekibe sorulan soruyla aynı: 20 dakika). */
export const WAITING_MINUTES = 20;
/** Bundan eski bekleyenler için hatırlatma düşmez (ilk açılışta eski kayıtlar ekibi boğmasın). */
const MAX_AGE_HOURS = 48;
const MAX_TEXT = 1000;

type Waiting = { conversationId: string; since: Date; why: "human" | "handoff" };

/** Şu an ekibin dönüşünü bekleyen konuşmalar: ekipte olup son mesajı müşteriden olan ve kimsenin devralmadığı açık devirler. */
async function waitingOnTeam(db: DB, tenantId: string): Promise<Waiting[]> {
  const human = (await awaitingReplyInHuman(db, tenantId)).flatMap((r) => (r.since ? [{ conversationId: r.id, since: r.since, why: "human" as const }] : []));
  const untaken = await db
    .select({ conversationId: handoffs.conversationId, since: sql<Date>`min(${handoffs.createdAt})`.mapWith((v) => new Date(v)) })
    .from(handoffs)
    .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
    .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.status, "open"), eq(conversations.status, "waiting")))
    .groupBy(handoffs.conversationId);
  const seen = new Set(human.map((h) => h.conversationId));
  return [...human, ...untaken.filter((u) => !seen.has(u.conversationId)).map((u) => ({ ...u, why: "handoff" as const }))];
}

/**
 * Ekibin dönüşünü 20 dakikadır bekleyen müşteri için ekibe önemli bildirim düşer (konuşma başına, bekleyiş başına bir kez):
 * konuşma ekipte ama son mesaj müşteriden ya da müşteri temsilci istemiş, devri kimse devralmamış.
 * Yalnızca mesaideyken çalışır; gece bekleyen sabah açılışta hatırlatılır. Ekip cevap verince ya da konuşmayı
 * Lina'ya geri verince bildirim kendiliğinden kapanır. Müşteriye ikinci bir mesaj gitmez. Kaç hatırlatma düştüğünü döner.
 */
export async function escalateWaitingCustomers(
  deps: { db: DB; events?: EventBus },
  tenant: Tenant,
  timeZone: string,
  now: Date = new Date(),
): Promise<number> {
  const { db } = deps;
  const waiting = await waitingOnTeam(db, tenant.id);

  // Artık beklemeyen konuşmaların açık hatırlatmaları kapanır (ekip cevapladı, devraldı ya da Lina'ya geri verdi).
  const open = await db
    .select({ id: notifications.id, conversationId: notifications.conversationId })
    .from(notifications)
    .where(and(eq(notifications.tenantId, tenant.id), eq(notifications.kind, "customer_waiting"), eq(notifications.status, "open")));
  const still = new Set(waiting.map((w) => w.conversationId));
  const resolved = open.filter((n) => !still.has(n.conversationId));
  if (resolved.length) {
    await db.update(notifications).set({ status: "done", doneAt: now }).where(inArray(notifications.id, resolved.map((n) => n.id)));
    deps.events?.publish(tenant.id, { type: "notification_update", conversationId: resolved[0]!.conversationId });
  }

  const settings = resolveSettings(tenant.settings);
  if (!businessStatus(settings.businessHours, timeZone, now).open) return 0;

  const cutoff = new Date(now.getTime() - WAITING_MINUTES * 60_000);
  const oldest = new Date(now.getTime() - MAX_AGE_HOURS * 60 * 60_000);
  let raised = 0;
  for (const w of waiting.filter((x) => x.since <= cutoff && x.since >= oldest)) {
    // Bu bekleyiş için zaten hatırlatıldı (açık ya da ekibin kapattığı): yenisi düşmez.
    const [known] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.conversationId, w.conversationId),
          eq(notifications.kind, "customer_waiting"),
          sql`(${notifications.status} = 'open' or ${notifications.createdAt} >= ${w.since})`,
        ),
      )
      .limit(1);
    if (known) continue;
    const [last] = await db
      .select({ text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, w.conversationId), eq(messages.sender, "customer"), ne(messages.type, "note")))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(1);
    const minutes = Math.max(WAITING_MINUTES, Math.round((now.getTime() - w.since.getTime()) / 60_000));
    await db.insert(notifications).values({
      tenantId: tenant.id,
      conversationId: w.conversationId,
      kind: "customer_waiting",
      important: true,
      orderNames: [],
      question: (last?.text ?? "").slice(0, MAX_TEXT),
      answer: "",
      details: {
        kinds: ["customer_waiting"],
        issues: [
          w.why === "human"
            ? `Müşteri ${minutes} dakikadır ekibin dönüşünü bekliyor: konuşma ekipte ama son mesaj müşterinin. Müşteriye yazın ya da konuşmayı Lina'ya geri verin.`
            : `Müşteri ${minutes} dakikadır ekibin dönüşünü bekliyor: devri kimse devralmadı. Konuşmayı devralıp müşteriye yazın.`,
        ],
      },
      createdAt: now,
    });
    deps.events?.publish(tenant.id, { type: "notification", conversationId: w.conversationId, important: true });
    raised++;
  }
  return raised;
}
