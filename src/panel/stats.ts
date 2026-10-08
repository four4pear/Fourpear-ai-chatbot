import type { NextFunction, Request, Response, Router } from "express";
import { and, eq, gte } from "drizzle-orm";
import { businessStatus } from "../core/business-hours.js";
import type { DB } from "../db/client.js";
import { handoffs, messages, notifications, resolveSettings, teamQuestions, tenants, type MemberRole } from "../db/schema.js";
import { param } from "./api.js";
import { NOTIFICATION_LABELS } from "./notifications.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

const PERIODS = new Set([1, 7, 30]);
const HOUR_MS = 60 * 60 * 1000;

const HANDOFF_LABELS: Record<string, string> = {
  customer_request: "Müşteri temsilci istedi",
  complaint: "Şikayet",
  return_or_cancel: "İade ya da iptal",
  unknown_answer: "Cevabı bilinmiyor",
  other: "Diğer",
};
const QUESTION_LABEL = "Lina ekibe soru sordu";

export type Stats = {
  days: number;
  /** Müşterinin yazdığı konuşmalar. */
  conversations: number;
  /** Ekip devreye girmeden biten konuşmalar. */
  solvedByLina: number;
  /** Ekibin devreye girdiği konuşmalar: devir, önemli bildirim, Lina'nın sorusu ya da ekibin yazdığı mesaj. */
  team: number;
  /** Devirden ekibin ilk mesajına ortalama dakika; ekip henüz yazmadıysa null. */
  avgResponseMinutes: number | null;
  /** Mesai saatleri dışında yazılan konuşmalar. */
  afterHours: number;
  /** Ekibe giden işlerin sebepleri (iş sayısı; bir konuşma birden çok sebep taşıyabilir). */
  reasons: { label: string; count: number }[];
  /** Tek günlük bakışta saat, diğerlerinde gün. */
  bucketSize: "hour" | "day";
  buckets: { key: string; solved: number; team: number }[];
};

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Yerel saatte "2026-10-07" (gün) ya da "2026-10-07T14" (saat). */
function bucketKey(date: Date, timeZone: string, size: "hour" | "day") {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  return size === "day" ? day : `${day}T${p.hour}`;
}

/** Grafikte boş günler de görünsün: pencere boyunca sırayla bütün kovalar. */
function bucketKeys(since: Date, now: Date, timeZone: string, size: "hour" | "day") {
  const keys: string[] = [];
  const add = (d: Date) => {
    const key = bucketKey(d, timeZone, size);
    if (keys[keys.length - 1] !== key) keys.push(key);
  };
  for (let t = since.getTime(); t <= now.getTime(); t += HOUR_MS) add(new Date(t));
  add(now);
  return keys;
}

export async function computeStats(db: DB, tenantId: string, days: number, timeZone: string, now: Date): Promise<Stats> {
  const since = new Date(now.getTime() - days * 24 * HOUR_MS);
  const size = days === 1 ? "hour" : "day";
  const [tenant] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const hours = resolveSettings(tenant?.settings).businessHours;

  const [customerMsgs, agentMsgs, handoffRows, notified, asked] = await Promise.all([
    db.select({ conversationId: messages.conversationId, at: messages.createdAt }).from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.sender, "customer"), gte(messages.createdAt, since))),
    db.select({ conversationId: messages.conversationId, at: messages.createdAt }).from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.sender, "agent"), gte(messages.createdAt, since))),
    db.select({ conversationId: handoffs.conversationId, reason: handoffs.reason, at: handoffs.createdAt }).from(handoffs)
      .where(and(eq(handoffs.tenantId, tenantId), gte(handoffs.createdAt, since))),
    db.select({ conversationId: notifications.conversationId, kind: notifications.kind, at: notifications.createdAt }).from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.important, true), gte(notifications.createdAt, since))),
    db.select({ conversationId: teamQuestions.conversationId, at: teamQuestions.createdAt }).from(teamQuestions)
      .where(and(eq(teamQuestions.tenantId, tenantId), gte(teamQuestions.createdAt, since))),
  ]);

  const active = new Set(customerMsgs.map((m) => m.conversationId));
  // Ekibin devreye girdiği an(lar), yalnızca bu dönemde müşterinin yazdığı konuşmalar için.
  const teamEvents = [
    ...handoffRows.map((h) => ({ conversationId: h.conversationId, at: h.at })),
    ...notified.map((n) => ({ conversationId: n.conversationId, at: n.at })),
    ...asked.map((q) => ({ conversationId: q.conversationId, at: q.at })),
    ...agentMsgs.map((m) => ({ conversationId: m.conversationId, at: m.at })),
  ].filter((e) => active.has(e.conversationId));
  const teamConversations = new Set(teamEvents.map((e) => e.conversationId));

  // Devirden ekibin ilk mesajına geçen süre.
  const waits: number[] = [];
  for (const h of handoffRows) {
    const reply = agentMsgs.filter((m) => m.conversationId === h.conversationId && m.at >= h.at).reduce<Date | null>((first, m) => (first === null || m.at < first ? m.at : first), null);
    if (reply) waits.push((reply.getTime() - h.at.getTime()) / 60_000);
  }

  // Mesai dışı: dakikaya göre önbellek (aynı dakikadaki mesajlar için yeniden hesaplanmaz).
  const openAt = new Map<number, boolean>();
  const isOpen = (d: Date) => {
    const minute = Math.floor(d.getTime() / 60_000);
    let open = openAt.get(minute);
    if (open === undefined) openAt.set(minute, (open = businessStatus(hours, timeZone, d).open));
    return open;
  };
  const afterHours = new Set<string>();
  for (const m of customerMsgs) if (!afterHours.has(m.conversationId) && !isOpen(m.at)) afterHours.add(m.conversationId);

  const reasonCounts = new Map<string, number>();
  const bump = (label: string) => reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
  for (const h of handoffRows) if (active.has(h.conversationId)) bump(HANDOFF_LABELS[h.reason] ?? HANDOFF_LABELS.other!);
  for (const n of notified) if (active.has(n.conversationId)) bump(NOTIFICATION_LABELS[n.kind] ?? n.kind);
  for (const q of asked) if (active.has(q.conversationId)) bump(QUESTION_LABEL);

  // Grafik: her kovada müşterinin yazdığı konuşmalar; o kovada ekip devreye girdiyse "ekip", girmediyse "Lina".
  const perBucket = new Map<string, { customer: Set<string>; team: Set<string> }>();
  const slot = (key: string) => {
    let s = perBucket.get(key);
    if (!s) perBucket.set(key, (s = { customer: new Set(), team: new Set() }));
    return s;
  };
  for (const m of customerMsgs) slot(bucketKey(m.at, timeZone, size)).customer.add(m.conversationId);
  for (const e of teamEvents) slot(bucketKey(e.at, timeZone, size)).team.add(e.conversationId);
  const buckets = bucketKeys(since, now, timeZone, size).map((key) => {
    const s = perBucket.get(key);
    const team = s ? [...s.customer].filter((id) => s.team.has(id)).length : 0;
    return { key, solved: s ? s.customer.size - team : 0, team };
  });

  return {
    days,
    conversations: active.size,
    solvedByLina: active.size - teamConversations.size,
    team: teamConversations.size,
    avgResponseMinutes: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
    afterHours: afterHours.size,
    reasons: [...reasonCounts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "tr")),
    bucketSize: size,
    buckets,
  };
}

/** Konuşma istatistikleri (panel İstatistik): sayılar, günlük dağılım, ekibe giden işlerin sebepleri. Yalnızca mağaza sahibi. */
export function registerStatsRoutes(
  api: Router,
  deps: { db: DB; timeZone: string; now?: () => Date },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  api.get("/tenants/:tenantId/stats", guards.requireUser, guards.requireTenant("owner"), async (req, res) => {
    const days = PERIODS.has(Number(req.query.days)) ? Number(req.query.days) : 7;
    res.json(await computeStats(deps.db, param(req, "tenantId"), days, deps.timeZone, deps.now?.() ?? new Date()));
  });
}
