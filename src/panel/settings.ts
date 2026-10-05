import type { NextFunction, Request, Response, Router } from "express";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { resolveSettings, tenants, type MemberRole } from "../db/schema.js";
import { param } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Mağaza ayarları (panel Ayarlar). Şimdilik: Lina'yı açıp kapatma. Yalnızca mağaza sahibi.
 * Kapalıyken Lina hiçbir müşteriye cevap vermez; mesajlar panelde görünür, ekip konuşmaları devralıp yazabilir.
 */
export function registerSettingsRoutes(
  api: Router,
  deps: { db: DB },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const owner = [guards.requireUser, guards.requireTenant("owner")];
  const view = (settings: Parameters<typeof resolveSettings>[0]) => ({ botEnabled: resolveSettings(settings).botEnabled });

  api.get("/tenants/:tenantId/settings", ...owner, async (req, res) => {
    const [tenant] = await deps.db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, param(req, "tenantId")));
    if (!tenant) return res.status(404).json({ error: "Mağaza bulunamadı" });
    res.json(view(tenant.settings));
  });

  api.patch("/tenants/:tenantId/settings", ...owner, async (req, res) => {
    if (typeof req.body?.botEnabled !== "boolean") return res.status(400).json({ error: "Geçersiz ayar." });
    const [tenant] = await deps.db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, param(req, "tenantId")));
    if (!tenant) return res.status(404).json({ error: "Mağaza bulunamadı" });
    const settings = { ...resolveSettings(tenant.settings), botEnabled: req.body.botEnabled };
    await deps.db.update(tenants).set({ settings }).where(eq(tenants.id, param(req, "tenantId")));
    res.json(view(settings));
  });
}
