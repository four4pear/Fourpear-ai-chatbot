import { and, eq, gt, isNull } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { authTokens, memberships, sessions, tenants, users, type MemberRole, type User } from "../db/schema.js";
import { DUMMY_HASH, MIN_PASSWORD_LENGTH, hashPassword, randomToken, tokenHash, verifyPassword } from "./password.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** E-posta ve şifreyi doğrular. Kullanıcı yoksa da aynı sürede cevap verir. */
export async function checkCredentials(db: DB, email: string, password: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  return ok && user?.passwordHash ? user : null;
}

export async function createSession(db: DB, userId: string, userAgent: string | undefined, now = new Date()) {
  const token = randomToken();
  await db.insert(sessions).values({
    userId,
    tokenHash: tokenHash(token),
    userAgent: userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  return token;
}

export async function userForSession(db: DB, token: string, now = new Date()): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, now)));
  return row?.user ?? null;
}

export async function destroySession(db: DB, token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
}

export type MembershipView = { tenantId: string; slug: string; name: string; role: MemberRole };

export async function membershipsOf(db: DB, userId: string): Promise<MembershipView[]> {
  return db
    .select({ tenantId: tenants.id, slug: tenants.slug, name: tenants.name, role: memberships.role })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, userId))
    .orderBy(tenants.name);
}

/**
 * Kullanıcının bu mağazadaki rolü. Yönetici her mağazada sahip yetkisindedir.
 * Üye değilse null: o mağazanın hiçbir verisine erişemez.
 */
export async function roleIn(db: DB, user: User, tenantId: string): Promise<MemberRole | null> {
  if (user.isSuperAdmin) return "owner";
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.tenantId, tenantId)));
  return m?.role ?? null;
}

/** Mağazaya davet linki anahtarı üretir (7 gün, tek kullanımlık). */
export async function createInvite(
  db: DB,
  opts: { tenantId: string; email: string; role: MemberRole; createdBy: string | null },
  now = new Date(),
): Promise<string> {
  const token = randomToken();
  await db.insert(authTokens).values({
    kind: "invite",
    tokenHash: tokenHash(token),
    email: normalizeEmail(opts.email),
    tenantId: opts.tenantId,
    role: opts.role,
    createdBy: opts.createdBy,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  });
  return token;
}

/** Şifre belirleme/sıfırlama linki anahtarı (24 saat, tek kullanımlık). */
export async function createResetToken(db: DB, userId: string, createdBy: string | null, now = new Date()): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new AuthError(404, "Kullanıcı bulunamadı");
  const token = randomToken();
  await db.insert(authTokens).values({
    kind: "reset",
    tokenHash: tokenHash(token),
    email: user.email,
    userId,
    createdBy,
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
  });
  return token;
}

/** Linkin geçerli olup olmadığı ve sayfada gösterilecek bilgiler. */
export async function describeToken(db: DB, token: string, now = new Date()) {
  const [row] = await db
    .select({ t: authTokens, tenantName: tenants.name, tenantSlug: tenants.slug })
    .from(authTokens)
    .leftJoin(tenants, eq(tenants.id, authTokens.tenantId))
    .where(and(eq(authTokens.tokenHash, tokenHash(token)), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)));
  if (!row) return null;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.t.email));
  return {
    kind: row.t.kind,
    email: row.t.email,
    tenantName: row.tenantName,
    tenantSlug: row.tenantSlug,
    role: row.t.role,
    /** Davet edilen kişinin zaten hesabı varsa isim/şifre sorulmaz; giriş yapması yeterli. */
    hasAccount: Boolean(existing),
  };
}

/**
 * Linki kullanır: davette hesap yoksa oluşturur ve mağazaya ekler; sıfırlamada şifreyi değiştirir
 * ve tüm eski oturumları kapatır. Dönen kullanıcı için oturum açılır.
 */
export async function acceptToken(
  db: DB,
  token: string,
  /** currentUserId: linki açan kişi zaten oturum açmışsa onun kimliği */
  input: { name?: string; password?: string; currentUserId?: string },
  now = new Date(),
): Promise<User> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, tokenHash(token)), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
      .for("update");
    if (!row) throw new AuthError(400, "Link geçersiz, kullanılmış ya da süresi dolmuş");

    const [existing] = await tx.select().from(users).where(eq(users.email, row.email));
    const setsNewPassword = row.kind === "reset" || !existing;
    if (setsNewPassword && (!input.password || input.password.length < MIN_PASSWORD_LENGTH)) {
      throw new AuthError(400, `Şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı`);
    }

    let user: User;
    if (row.kind === "reset") {
      if (!existing) throw new AuthError(400, "Kullanıcı bulunamadı");
      [user] = (await tx
        .update(users)
        .set({ passwordHash: await hashPassword(input.password!) })
        .where(eq(users.id, existing.id))
        .returning()) as [User];
      // Şifre değişince eski oturumlar geçersiz.
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
    } else {
      if (existing) {
        // Linki ele geçiren biri bu hesapla oturum açamasın: hesap sahibi olduğunu kanıtlamalı.
        const provesOwnership =
          input.currentUserId === existing.id ||
          (existing.passwordHash !== null && (await verifyPassword(input.password ?? "", existing.passwordHash)));
        if (!provesOwnership) throw new AuthError(401, "Bu e-postanın hesabı var: daveti kabul etmek için şifrenizi girin");
        user = existing;
      } else {
        const name = input.name?.trim();
        if (!name) throw new AuthError(400, "Ad gerekli");
        [user] = (await tx
          .insert(users)
          .values({ email: row.email, name, passwordHash: await hashPassword(input.password!) })
          .returning()) as [User];
      }
      await tx
        .insert(memberships)
        .values({ userId: user.id, tenantId: row.tenantId!, role: row.role! })
        .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role: row.role! } });
    }

    await tx.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
    return user;
  });
}
