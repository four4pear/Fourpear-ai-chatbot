import type { NextFunction, Request, Response, Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { knowledgeAlerts, type MemberRole } from "../db/schema.js";
import { isUuid, param } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Kaynak çelişkisi uyarıları: mağaza bilgi uzmanı sayfalar ya da politikalar aynı konuda farklı şey söylüyorsa
 * uyarı açar (aynı konuda açık uyarı varken yenisi açılmaz). Mağaza sahibi görür; düzeltince (siteyi ya da
 * Lina'ya notları) "Çözüldü" der.
 */
export function registerKnowledgeAlertRoutes(
  api: Router,
  deps: { db: DB },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  const owner = [guards.requireUser, guards.requireTenant("owner")];

  api.get("/tenants/:tenantId/knowledge-alerts", ...owner, async (req, res) => {
    const rows = await deps.db
      .select()
      .from(knowledgeAlerts)
      .where(and(eq(knowledgeAlerts.tenantId, param(req, "tenantId")), eq(knowledgeAlerts.status, "open")))
      .orderBy(desc(knowledgeAlerts.createdAt))
      .limit(50);
    res.json({ alerts: rows.map((a) => ({ id: a.id, topic: a.topic, description: a.description, createdAt: a.createdAt, conversationId: a.conversationId })) });
  });

  api.post("/tenants/:tenantId/knowledge-alerts/:alertId/resolve", ...owner, async (req, res) => {
    const alertId = param(req, "alertId");
    if (!isUuid(alertId)) return res.status(404).json({ error: "Uyarı bulunamadı" });
    const done = await deps.db
      .update(knowledgeAlerts)
      .set({ status: "resolved" })
      .where(and(eq(knowledgeAlerts.id, alertId), eq(knowledgeAlerts.tenantId, param(req, "tenantId")), eq(knowledgeAlerts.status, "open")))
      .returning({ id: knowledgeAlerts.id });
    if (!done.length) return res.status(404).json({ error: "Uyarı bulunamadı" });
    res.json({ ok: true });
  });
}
