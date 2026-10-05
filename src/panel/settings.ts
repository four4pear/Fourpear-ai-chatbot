import type { NextFunction, Request, Response, Router } from "express";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { resolveSettings, tenants, type MemberRole } from "../db/schema.js";
import { param } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Mağaza ayarları (panel Ayarlar), yalnızca mağaza sahibi:
 * - Lina'yı aç/kapat: kapalıyken hiçbir müşteriye cevap vermez; mesajlar panelde görünür, ekip yazabilir.
 * - Mesai saatleri ve "Lina yalnızca mesai saatlerinde": mesai dışındaki mesajlar kaydedilir, açılışta cevaplanır.
 */
export function registerSettingsRoutes(
  api: Router,
  deps: { db: DB },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const owner = [guards.requireUser, guards.requireTenant("owner")];
  const view = (settings: Parameters<typeof resolveSettings>[0]) => {
    const s = resolveSettings(settings);
    return { botEnabled: s.botEnabled, botHoursOnly: s.botHoursOnly, businessHours: s.businessHours };
  };

  api.get("/tenants/:tenantId/settings", ...owner, async (req, res) => {
    const [tenant] = await deps.db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, param(req, "tenantId")));
    if (!tenant) return res.status(404).json({ error: "Mağaza bulunamadı" });
    res.json(view(tenant.settings));
  });

  api.patch("/tenants/:tenantId/settings", ...owner, async (req, res) => {
    const { botEnabled, botHoursOnly, businessHours: hours } = req.body ?? {};
    const validHours =
      hours === undefined ||
      (Array.isArray(hours?.days) && hours.days.length > 0 && hours.days.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
        typeof hours.start === "string" && typeof hours.end === "string" && TIME.test(hours.start) && TIME.test(hours.end) && hours.start < hours.end);
    if ((botEnabled !== undefined && typeof botEnabled !== "boolean") || (botHoursOnly !== undefined && typeof botHoursOnly !== "boolean") || !validHours ||
      (botEnabled === undefined && botHoursOnly === undefined && hours === undefined)) {
      return res.status(400).json({ error: "Geçersiz ayar. Saatler 10:00 biçiminde, başlangıç bitişten önce olmalı; en az bir gün seçilmeli." });
    }
    const [tenant] = await deps.db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, param(req, "tenantId")));
    if (!tenant) return res.status(404).json({ error: "Mağaza bulunamadı" });
    const settings = {
      ...resolveSettings(tenant.settings),
      ...(botEnabled !== undefined && { botEnabled }),
      ...(botHoursOnly !== undefined && { botHoursOnly }),
      ...(hours !== undefined && { businessHours: { days: [...new Set<number>(hours.days)].sort(), start: hours.start, end: hours.end } }),
    };
    await deps.db.update(tenants).set({ settings }).where(eq(tenants.id, param(req, "tenantId")));
    res.json(view(settings));
  });
}
