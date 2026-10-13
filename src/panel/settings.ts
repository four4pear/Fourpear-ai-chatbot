import type { NextFunction, Request, Response, Router } from "express";
import { eq } from "drizzle-orm";
import { DEFAULT_TEXTS } from "../core/texts.js";
import type { DB } from "../db/client.js";
import { botIsOn, resolveSettings, tenants, type FixedTextKey, type MemberRole, type TenantSettings } from "../db/schema.js";
import { param } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Sayısal ayarlar ve izin verilen aralıklar: [en az, en çok]. */
export const LIMIT_RANGES = {
  replyDelaySeconds: [0, 120],
  maxReplyWaitSeconds: [10, 600],
  dailyMessageLimit: [10, 2000],
  dailyStoreMessageLimit: [100, 50_000],
} as const;
type LimitKey = keyof typeof LIMIT_RANGES;
const LIMIT_LABELS: Record<LimitKey, string> = {
  replyDelaySeconds: "Cevap bekleme süresi",
  maxReplyWaitSeconds: "En fazla bekleme süresi",
  dailyMessageLimit: "Müşteri başına günlük mesaj sınırı",
  dailyStoreMessageLimit: "Mağaza günlük mesaj sınırı",
};

/** Teslimat süresi kuralı için izin verilen gün aralığı. */
export const DELIVERY_RANGE = [1, 90] as const;
const MAX_NOTES = 8000;
const MAX_PLAYBOOK = 20_000;
const MAX_TEXT = 500;
const TEXT_KEYS: FixedTextKey[] = ["unsupported", "failure"];

/**
 * Mağaza ayarları (panel Ayarlar), yalnızca mağaza sahibi:
 * - Lina'yı aç/kapat: kapalıyken hiçbir müşteriye cevap vermez; mesajlar panelde görünür, ekip yazabilir.
 * - Mesai saatleri ve "Lina yalnızca mesai saatlerinde": mesai dışındaki mesajlar kaydedilir, açılışta cevaplanır.
 * - Lina'ya notlar, müşteriye giden sabit metinler, cevap hızı ve günlük sınırlar, iade el kitabı.
 */
export function registerSettingsRoutes(
  api: Router,
  deps: { db: DB },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const owner = [guards.requireUser, guards.requireTenant("owner")];
  const view = (row: { settings: Parameters<typeof resolveSettings>[0]; notes: string }) => {
    const s = resolveSettings(row.settings);
    return {
      botEnabled: botIsOn(s, new Date()),
      botUntil: s.botUntil,
      botHoursOnly: s.botHoursOnly,
      businessHours: s.businessHours,
      notes: row.notes,
      // Mağazanın kendi yazdığı metin; boşsa Lina hazır metni (müşterinin diline göre) gönderir.
      texts: { unsupported: s.texts.unsupported ?? "", failure: s.texts.failure ?? "" },
      defaultTexts: DEFAULT_TEXTS,
      returnsPlaybook: s.returnsPlaybook,
      deliveryDays: s.deliveryDays,
      deliveryRange: DELIVERY_RANGE,
      limits: {
        replyDelaySeconds: s.replyDelaySeconds,
        maxReplyWaitSeconds: s.maxReplyWaitSeconds,
        dailyMessageLimit: s.dailyMessageLimit,
        dailyStoreMessageLimit: s.dailyStoreMessageLimit,
      },
      limitRanges: LIMIT_RANGES,
    };
  };
  const load = async (tenantId: string) => {
    const [row] = await deps.db.select({ settings: tenants.settings, notes: tenants.notes }).from(tenants).where(eq(tenants.id, tenantId));
    return row ?? null;
  };

  api.get("/tenants/:tenantId/settings", ...owner, async (req, res) => {
    const row = await load(param(req, "tenantId"));
    if (!row) return res.status(404).json({ error: "Mağaza bulunamadı" });
    res.json(view(row));
  });

  api.patch("/tenants/:tenantId/settings", ...owner, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bad = (error: string) => res.status(400).json({ error });
    const patch: Partial<TenantSettings> = {};
    let notes: string | undefined;
    let touched = 0;

    if (body.botEnabled !== undefined) {
      if (typeof body.botEnabled !== "boolean") return bad("Lina'nın açık/kapalı durumu geçersiz.");
      patch.botEnabled = body.botEnabled;
      patch.botUntil = null; // panelden açıp kapatınca zamanlı kapanış iptal olur
      touched++;
    }
    if (body.botHoursOnly !== undefined) {
      if (typeof body.botHoursOnly !== "boolean") return bad("Mesai ayarı geçersiz.");
      patch.botHoursOnly = body.botHoursOnly;
      touched++;
    }
    if (body.businessHours !== undefined) {
      const h = body.businessHours as { days?: unknown; start?: unknown; end?: unknown };
      const valid =
        Array.isArray(h?.days) && h.days.length > 0 && h.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
        typeof h.start === "string" && typeof h.end === "string" && TIME.test(h.start) && TIME.test(h.end) && h.start < h.end;
      if (!valid) return bad("Geçersiz ayar. Saatler 10:00 biçiminde, başlangıç bitişten önce olmalı; en az bir gün seçilmeli.");
      patch.businessHours = { days: [...new Set<number>(h.days as number[])].sort(), start: h.start as string, end: h.end as string };
      touched++;
    }
    if (body.notes !== undefined) {
      if (typeof body.notes !== "string" || body.notes.length > MAX_NOTES) return bad(`Notlar en fazla ${MAX_NOTES} karakter olabilir.`);
      notes = body.notes.trim();
      touched++;
    }
    if (body.returnsPlaybook !== undefined) {
      if (typeof body.returnsPlaybook !== "string" || body.returnsPlaybook.length > MAX_PLAYBOOK) return bad(`İade el kitabı en fazla ${MAX_PLAYBOOK} karakter olabilir.`);
      patch.returnsPlaybook = body.returnsPlaybook.trim();
      touched++;
    }
    for (const key of Object.keys(LIMIT_RANGES) as LimitKey[]) {
      if (body[key] === undefined) continue;
      const [min, max] = LIMIT_RANGES[key];
      const value = body[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return bad(`${LIMIT_LABELS[key]} ${min} ile ${max} arasında olmalı.`);
      patch[key] = value;
      touched++;
    }
    if (body.deliveryDays !== undefined) {
      const d = body.deliveryDays as { min?: unknown; max?: unknown } | null;
      if (d !== null) {
        const [lo, hi] = DELIVERY_RANGE;
        const ok = typeof d === "object" && Number.isInteger(d.min) && Number.isInteger(d.max) && (d.min as number) >= lo && (d.max as number) <= hi && (d.min as number) <= (d.max as number);
        if (!ok) return bad(`Teslimat süresi ${lo} ile ${hi} gün arasında olmalı; en az, en çoktan büyük olamaz.`);
        patch.deliveryDays = { min: d.min as number, max: d.max as number };
      } else patch.deliveryDays = null;
      touched++;
    }
    const texts = body.texts as Record<string, unknown> | undefined;
    if (texts !== undefined) {
      if (typeof texts !== "object" || texts === null || Array.isArray(texts) || Object.keys(texts).some((k) => !TEXT_KEYS.includes(k as FixedTextKey))) return bad("Metin ayarı geçersiz.");
      for (const k of TEXT_KEYS) if (texts[k] !== undefined && (typeof texts[k] !== "string" || (texts[k] as string).length > MAX_TEXT)) return bad(`Metinler en fazla ${MAX_TEXT} karakter olabilir.`);
      touched++;
    }
    if (!touched) return bad("Değiştirilecek bir ayar gönderilmedi.");

    const tenantId = param(req, "tenantId");
    const row = await load(tenantId);
    if (!row) return res.status(404).json({ error: "Mağaza bulunamadı" });
    const settings: TenantSettings = { ...resolveSettings(row.settings), ...patch };
    if (texts !== undefined) {
      // Boş metin = mağaza kendi metnini sildi: hazır metne dönülür.
      const next = { ...settings.texts };
      for (const k of TEXT_KEYS) {
        if (texts[k] === undefined) continue;
        const text = (texts[k] as string).trim();
        if (text) next[k] = text;
        else delete next[k];
      }
      settings.texts = next;
    }
    if (settings.maxReplyWaitSeconds < settings.replyDelaySeconds) return bad("En fazla bekleme süresi, cevap bekleme süresinden kısa olamaz.");

    await deps.db.update(tenants).set({ settings, ...(notes !== undefined && { notes }) }).where(eq(tenants.id, tenantId));
    res.json(view({ settings, notes: notes ?? row.notes }));
  });
}
