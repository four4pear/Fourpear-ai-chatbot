import type { NextFunction, Request, Response, Router } from "express";
import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { costUsd } from "../core/pricing.js";
import type { DB } from "../db/client.js";
import { agentRuns, type MemberRole } from "../db/schema.js";
import { param } from "./api.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

const PERIODS = new Set([1, 7, 30]);

/**
 * Kullanım ve maliyet (panel İstatistik): ajan bazında çağrı, token, önbellek ve tahmini tutar.
 * Canlı (müşteri konuşmaları) ve test (panel test ekranı) ayrı. Yalnızca mağaza sahibi.
 */
export function registerUsageRoutes(
  api: Router,
  deps: { db: DB },
  guards: { requireUser: Middleware; requireTenant: (need: MemberRole) => Middleware },
) {
  api.get("/tenants/:tenantId/usage", guards.requireUser, guards.requireTenant("owner"), async (req, res) => {
    const days = PERIODS.has(Number(req.query.days)) ? Number(req.query.days) : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await deps.db
      .select({
        agent: agentRuns.agent,
        model: agentRuns.model,
        source: agentRuns.source,
        runs: count(),
        apiCalls: sum(agentRuns.apiCalls).mapWith(Number),
        inputTokens: sum(agentRuns.inputTokens).mapWith(Number),
        outputTokens: sum(agentRuns.outputTokens).mapWith(Number),
        cacheReadTokens: sum(agentRuns.cacheReadTokens).mapWith(Number),
        cacheWriteTokens: sum(agentRuns.cacheWriteTokens).mapWith(Number),
        avgMs: sql<number>`avg(${agentRuns.durationMs})`.mapWith(Number),
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.tenantId, param(req, "tenantId")), gte(agentRuns.createdAt, since)))
      .groupBy(agentRuns.agent, agentRuns.model, agentRuns.source);

    const withCost = rows.map((r) => ({ ...r, costUsd: costUsd(r.model, r) }));
    const totals = (["live", "test"] as const).map((source) => {
      const mine = withCost.filter((r) => r.source === source);
      const cost = mine.reduce((n, r) => n + (r.costUsd ?? 0), 0);
      // Lina'nın her çalışması müşteriye giden bir cevaptır.
      const replies = mine.filter((r) => r.agent === "lina").reduce((n, r) => n + r.runs, 0);
      const read = mine.reduce((n, r) => n + r.cacheReadTokens, 0);
      const allInput = mine.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0);
      return { source, costUsd: cost, replies, perReplyUsd: replies ? cost / replies : null, cacheHitRate: allInput ? read / allInput : null };
    });
    res.json({ days, rows: withCost, totals });
  });
}
