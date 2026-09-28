import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { and, eq, ne } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { memberships, tenants, users, type MemberRole, type User } from "../db/schema.js";
import { FailureLimiter } from "../auth/rate-limit.js";
import {
  AuthError,
  SESSION_TTL_MS,
  acceptToken,
  checkCredentials,
  createInvite,
  createResetToken,
  createSession,
  describeToken,
  destroySession,
  membershipsOf,
  normalizeEmail,
  roleIn,
  userForSession,
} from "../auth/service.js";

export type PanelApiDeps = {
  db: DB;
  /** Davet/sıfırlama linklerinin başı, ör. https://panel.ornek.com */
  publicUrl: string;
  /** Durum değiştiren isteklerin gelebileceği adresler (CSRF koruması). */
  allowedOrigins: string[];
  /** https'te true: çerez sadece şifreli bağlantıda gönderilir. */
  secureCookies: boolean;
  log: Pick<Console, "info" | "warn" | "error">;
  /** Derlenmiş panel klasörü (varsayılan: panel/dist). */
  distDir?: string;
};

export const SESSION_COOKIE = "lina_session";

type Locals = { user?: User; sessionToken?: string };

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Express 5'te parametre tipi string | string[] olabilir. */
const param = (req: Request, name: string) => String(req.params[name]);

const emailOk = (email: unknown): email is string => typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
const isRole = (r: unknown): r is MemberRole => r === "owner" || r === "agent";

export function registerPanelApi(app: Express, deps: PanelApiDeps) {
  const { db } = deps;
  const api = express.Router();
  // 15 dakikada e-posta başına 5, IP başına 20 hatalı deneme.
  const emailFailures = new FailureLimiter(5, 15 * 60 * 1000);
  const ipFailures = new FailureLimiter(20, 15 * 60 * 1000);

  const setSessionCookie = (res: Response, token: string) =>
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: deps.secureCookies,
      path: "/",
      maxAge: SESSION_TTL_MS,
    });

  api.use(express.json({ limit: "100kb" }));

  // CSRF: durum değiştiren istekler yalnızca panelin kendi adresinden gelebilir.
  api.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.get("origin");
    if (!origin || !deps.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "İzin verilmeyen kaynak" });
      return;
    }
    next();
  });

  api.use(async (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const user = await userForSession(db, token);
      if (user) Object.assign(res.locals as Locals, { user, sessionToken: token });
    }
    next();
  });

  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    if (!(res.locals as Locals).user) {
      res.status(401).json({ error: "Oturum açın" });
      return;
    }
    next();
  };

  /** Mağazaya erişim: üye değilse 404 (mağazanın varlığı bile belli olmasın), sahip gerekiyorsa 403. */
  const requireTenant = (need: MemberRole) => async (req: Request, res: Response, next: NextFunction) => {
    const user = (res.locals as Locals).user!;
    const role = await roleIn(db, user, param(req, "tenantId"));
    if (!role) {
      res.status(404).json({ error: "Bulunamadı" });
      return;
    }
    if (need === "owner" && role !== "owner") {
      res.status(403).json({ error: "Bu işlem için mağaza sahibi olmalısınız" });
      return;
    }
    next();
  };

  async function me(user: User) {
    const list = user.isSuperAdmin
      ? (await db.select({ tenantId: tenants.id, slug: tenants.slug, name: tenants.name }).from(tenants).orderBy(tenants.name)).map(
          (t) => ({ ...t, role: "owner" as MemberRole }),
        )
      : await membershipsOf(db, user.id);
    return {
      user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin },
      memberships: list,
    };
  }

  api.post("/auth/login", async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "E-posta ve şifre gerekli" });
      return;
    }
    const emailKey = normalizeEmail(email);
    const ipKey = req.ip ?? "?";
    if (emailFailures.isBlocked(emailKey) || ipFailures.isBlocked(ipKey)) {
      res.status(429).json({ error: "Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin." });
      return;
    }
    const user = await checkCredentials(db, email, password);
    if (!user) {
      emailFailures.fail(emailKey);
      ipFailures.fail(ipKey);
      res.status(401).json({ error: "E-posta ya da şifre hatalı" });
      return;
    }
    emailFailures.reset(emailKey);
    setSessionCookie(res, await createSession(db, user.id, req.get("user-agent")));
    res.json(await me(user));
  });

  api.post("/auth/logout", async (_req, res) => {
    const token = (res.locals as Locals).sessionToken;
    if (token) await destroySession(db, token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  api.get("/me", requireUser, async (_req, res) => {
    res.json(await me((res.locals as Locals).user!));
  });

  // Davet / şifre linki sayfası: link geçerli mi, kimin için?
  api.get("/tokens/:token", async (req, res) => {
    const info = await describeToken(db, param(req, "token"));
    if (!info) {
      res.status(404).json({ error: "Link geçersiz, kullanılmış ya da süresi dolmuş" });
      return;
    }
    res.json(info);
  });

  api.post("/tokens/:token/accept", async (req, res) => {
    const ipKey = req.ip ?? "?";
    if (ipFailures.isBlocked(ipKey)) {
      res.status(429).json({ error: "Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin." });
      return;
    }
    const { name, password } = req.body ?? {};
    try {
      const user = await acceptToken(db, param(req, "token"), {
        name: typeof name === "string" ? name : undefined,
        password: typeof password === "string" ? password : undefined,
        currentUserId: (res.locals as Locals).user?.id,
      });
      setSessionCookie(res, await createSession(db, user.id, req.get("user-agent")));
      res.json(await me(user));
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      if (err.status === 401) ipFailures.fail(ipKey);
      res.status(err.status).json({ error: err.message });
    }
  });

  api.get("/tenants/:tenantId/members", requireUser, requireTenant("owner"), async (req, res) => {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: memberships.role, lastLoginAt: users.lastLoginAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, param(req, "tenantId")))
      .orderBy(users.name);
    res.json({ members: rows });
  });

  api.post("/tenants/:tenantId/invites", requireUser, requireTenant("owner"), async (req, res) => {
    const { email, role } = req.body ?? {};
    if (!emailOk(email) || !isRole(role)) {
      res.status(400).json({ error: "Geçerli bir e-posta ve rol (owner/agent) gerekli" });
      return;
    }
    const token = await createInvite(db, {
      tenantId: param(req, "tenantId"),
      email,
      role,
      createdBy: (res.locals as Locals).user!.id,
    });
    res.json({ link: `${deps.publicUrl}/davet/${token}`, expiresInDays: 7 });
  });

  /**
   * Çalışan şifresini unuttuysa sahip sıfırlama linki üretir. Başka mağazalarda da üyeliği olan
   * (ör. ajans) ya da yönetici olan birinin hesabını sadece platform yöneticisi sıfırlayabilir;
   * yoksa bir mağaza sahibi o hesap üzerinden başka mağazalara erişebilirdi.
   */
  api.post("/tenants/:tenantId/members/:userId/reset-link", requireUser, requireTenant("owner"), async (req, res) => {
    const requester = (res.locals as Locals).user!;
    const tenantId = param(req, "tenantId");
    const userId = param(req, "userId");
    const [member] = await db
      .select({ user: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    if (!member) {
      res.status(404).json({ error: "Bu mağazada böyle bir kullanıcı yok" });
      return;
    }
    const [elsewhere] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), ne(memberships.tenantId, tenantId)));
    if (!requester.isSuperAdmin && (elsewhere || member.user.isSuperAdmin)) {
      res.status(403).json({ error: "Bu kullanıcının başka mağazalarda da hesabı var; şifresini sadece platform yöneticisi sıfırlayabilir" });
      return;
    }
    const token = await createResetToken(db, userId, requester.id);
    res.json({ link: `${deps.publicUrl}/sifre/${token}`, expiresInHours: 24 });
  });

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    deps.log.error("Panel API hatası", err);
    res.status(500).json({ error: "Beklenmeyen bir hata oluştu" });
  });

  app.use("/api", api);
}
