import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { memberships, tenants, users } from "../src/db/schema.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { createInvite, createResetToken } from "../src/auth/service.js";

const ORIGIN = "http://panel.test";
const PASSWORD = "dogru-sifre-123";

let database: Database;
let tenantA: string;
let tenantB: string;

function startApp() {
  const deps = {
    db: database.db,
    log: { info() {}, warn() {}, error() {} },
  } as unknown as Deps;
  const { app } = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }, deps, undefined, {
    db: database.db,
    publicUrl: "http://panel.test",
    allowedOrigins: [ORIGIN],
    secureCookies: false,
    log: { info() {}, warn() {}, error() {} },
  });
  const server: Server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Panelden gelmiş gibi istek; cookie verilirse oturumla. */
  async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string | null } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers.cookie = opts.cookie;
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    if (origin) headers.origin = origin;
    const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const setCookie = res.headers.get("set-cookie");
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
      cookie: setCookie ? setCookie.split(";")[0]! : undefined,
    };
  }
  return { server, call };
}

let app: ReturnType<typeof startApp>;

async function createUser(email: string, opts: { superAdmin?: boolean; memberOf?: [string, "owner" | "agent"][] } = {}) {
  const [user] = await database.db
    .insert(users)
    .values({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD), isSuperAdmin: opts.superAdmin ?? false })
    .returning();
  for (const [tenantId, role] of opts.memberOf ?? []) {
    await database.db.insert(memberships).values({ userId: user!.id, tenantId, role });
  }
  return user!;
}

const login = async (email: string, password = PASSWORD) => app.call("POST", "/api/auth/login", { body: { email, password } });

beforeAll(async () => {
  database = await openDatabase({});
  const [a, b] = await database.db
    .insert(tenants)
    .values([
      { slug: "maius", name: "MAIUS" },
      { slug: "diger", name: "Diğer Mağaza" },
    ])
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;
  app = startApp();
});
afterAll(async () => {
  app.server.close();
  await database.close();
});

describe("şifre özeti", () => {
  it("doğru şifreyi kabul eder, yanlışı reddeder, her seferinde farklı tuz kullanır", async () => {
    const h1 = await hashPassword("abc-123-xyz");
    const h2 = await hashPassword("abc-123-xyz");
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain("abc-123-xyz");
    expect(await verifyPassword("abc-123-xyz", h1)).toBe(true);
    expect(await verifyPassword("abc-123-xyZ", h1)).toBe(false);
  });
});

describe("giriş ve oturum", () => {
  it("doğru şifreyle girer, /me mağazalarını döner, çıkışta oturum kapanır", async () => {
    await createUser("sahip@maius.test", { memberOf: [[tenantA, "owner"]] });
    const res = await login("Sahip@Maius.test ");
    expect(res.status).toBe(200);
    expect(res.cookie).toMatch(/^lina_session=/);
    expect(res.body.memberships).toEqual([{ tenantId: tenantA, slug: "maius", name: "MAIUS", role: "owner" }]);

    expect((await app.call("GET", "/api/me", { cookie: res.cookie })).status).toBe(200);
    await app.call("POST", "/api/auth/logout", { cookie: res.cookie });
    expect((await app.call("GET", "/api/me", { cookie: res.cookie })).status).toBe(401);
  });

  it("yanlış şifre ve olmayan kullanıcı aynı cevabı alır", async () => {
    const wrong = await login("sahip@maius.test", "yanlis-sifre-000");
    const nobody = await login("yok@maius.test", "yanlis-sifre-000");
    expect(wrong).toMatchObject({ status: 401, body: { error: "E-posta ya da şifre hatalı" } });
    expect(nobody).toMatchObject({ status: 401, body: { error: "E-posta ya da şifre hatalı" } });
  });

  it("5 hatalı denemeden sonra doğru şifreyi de 15 dk kabul etmez", async () => {
    const own = startApp(); // ayrı sınırlayıcı: diğer testleri etkilemesin
    try {
      await createUser("kilit@maius.test", { memberOf: [[tenantA, "agent"]] });
      for (let i = 0; i < 5; i++) {
        expect((await own.call("POST", "/api/auth/login", { body: { email: "kilit@maius.test", password: "yanlis-" + i } })).status).toBe(401);
      }
      const blocked = await own.call("POST", "/api/auth/login", { body: { email: "kilit@maius.test", password: PASSWORD } });
      expect(blocked.status).toBe(429);
    } finally {
      own.server.close();
    }
  });

  it("panel dışından gelen (Origin'siz ya da yabancı) istekleri reddeder", async () => {
    expect((await app.call("POST", "/api/auth/login", { body: { email: "sahip@maius.test", password: PASSWORD }, origin: null })).status).toBe(403);
    expect((await app.call("POST", "/api/auth/login", { body: { email: "sahip@maius.test", password: PASSWORD }, origin: "https://kotu.site" })).status).toBe(403);
  });
});

describe("davet", () => {
  it("sahip çalışan davet eder; çalışan linkle hesabını açar ve sadece o mağazayı görür; link tekrar kullanılamaz", async () => {
    const owner = await login("sahip@maius.test");
    const invite = await app.call("POST", `/api/tenants/${tenantA}/invites`, { cookie: owner.cookie, body: { email: "calisan@maius.test", role: "agent" } });
    expect(invite.status).toBe(200);
    const token = String(invite.body.link).split("/davet/")[1]!;

    const info = await app.call("GET", `/api/tokens/${token}`);
    expect(info.body).toMatchObject({ kind: "invite", email: "calisan@maius.test", tenantName: "MAIUS", role: "agent", hasAccount: false });

    expect((await app.call("POST", `/api/tokens/${token}/accept`, { body: { name: "Ayşe", password: "kisa" } })).status).toBe(400);
    const accepted = await app.call("POST", `/api/tokens/${token}/accept`, { body: { name: "Ayşe", password: "yeni-sifre-12345" } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.memberships).toEqual([{ tenantId: tenantA, slug: "maius", name: "MAIUS", role: "agent" }]);

    expect((await app.call("POST", `/api/tokens/${token}/accept`, { body: { name: "X", password: "baska-sifre-12345" } })).status).toBe(400);
    expect((await login("calisan@maius.test", "yeni-sifre-12345")).status).toBe(200);
  });

  it("çalışan davet oluşturamaz ve ekip listesini göremez", async () => {
    const agent = await login("calisan@maius.test", "yeni-sifre-12345");
    expect((await app.call("POST", `/api/tenants/${tenantA}/invites`, { cookie: agent.cookie, body: { email: "x@y.test", role: "agent" } })).status).toBe(403);
    expect((await app.call("GET", `/api/tenants/${tenantA}/members`, { cookie: agent.cookie })).status).toBe(403);
  });

  it("başka mağazanın verisine erişilemez (varlığı bile belli olmaz)", async () => {
    const owner = await login("sahip@maius.test");
    const other = await app.call("GET", `/api/tenants/${tenantB}/members`, { cookie: owner.cookie });
    expect(other.status).toBe(404);
    expect((await app.call("POST", `/api/tenants/${tenantB}/invites`, { cookie: owner.cookie, body: { email: "x@y.test", role: "owner" } })).status).toBe(404);
  });

  it("hesabı olan birine gelen daveti, link ele geçirilse bile şifresiz kabul edemez", async () => {
    await createUser("ajans@test.test", { memberOf: [[tenantA, "agent"]] });
    const token = await createInvite(database.db, { tenantId: tenantB, email: "ajans@test.test", role: "agent", createdBy: null });

    const info = await app.call("GET", `/api/tokens/${token}`);
    expect(info.body.hasAccount).toBe(true);
    const stolen = await app.call("POST", `/api/tokens/${token}/accept`, { body: {} });
    expect(stolen.status).toBe(401);
    expect(stolen.cookie).toBeUndefined();
    const guessed = await app.call("POST", `/api/tokens/${token}/accept`, { body: { password: "tahmin-edilen-1" } });
    expect(guessed.status).toBe(401);

    const real = await app.call("POST", `/api/tokens/${token}/accept`, { body: { password: PASSWORD } });
    expect(real.status).toBe(200);
    expect(real.body.memberships.map((m: { slug: string }) => m.slug).sort()).toEqual(["diger", "maius"]);
  });

  it("süresi dolmuş davet geçersizdir", async () => {
    const token = await createInvite(
      database.db,
      { tenantId: tenantA, email: "gec@maius.test", role: "agent", createdBy: null },
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    expect((await app.call("GET", `/api/tokens/${token}`)).status).toBe(404);
  });
});

describe("şifre sıfırlama", () => {
  it("sahip sadece kendi mağazasındaki çalışanın linkini üretir; şifre değişince eski oturumlar kapanır", async () => {
    const owner = await login("sahip@maius.test");
    const [agent] = await database.db.select().from(users).where(eq(users.email, "calisan@maius.test"));
    const oldSession = await login("calisan@maius.test", "yeni-sifre-12345");

    const reset = await app.call("POST", `/api/tenants/${tenantA}/members/${agent!.id}/reset-link`, { cookie: owner.cookie });
    expect(reset.status).toBe(200);
    const token = String(reset.body.link).split("/sifre/")[1]!;
    expect((await app.call("POST", `/api/tokens/${token}/accept`, { body: { password: "sifirlanmis-sifre-1" } })).status).toBe(200);

    expect((await app.call("GET", "/api/me", { cookie: oldSession.cookie })).status).toBe(401);
    expect((await login("calisan@maius.test", "yeni-sifre-12345")).status).toBe(401);
    expect((await login("calisan@maius.test", "sifirlanmis-sifre-1")).status).toBe(200);
  });

  it("başka mağazada da üyeliği olan kişinin şifresini mağaza sahibi sıfırlayamaz, yönetici sıfırlayabilir", async () => {
    const owner = await login("sahip@maius.test");
    const [ajans] = await database.db.select().from(users).where(eq(users.email, "ajans@test.test"));
    const denied = await app.call("POST", `/api/tenants/${tenantA}/members/${ajans!.id}/reset-link`, { cookie: owner.cookie });
    expect(denied.status).toBe(403);

    await createUser("yonetici@platform.test", { superAdmin: true });
    const admin = await login("yonetici@platform.test");
    expect(admin.body.memberships.map((m: { slug: string }) => m.slug).sort()).toEqual(["diger", "maius"]);
    const allowed = await app.call("POST", `/api/tenants/${tenantA}/members/${ajans!.id}/reset-link`, { cookie: admin.cookie });
    expect(allowed.status).toBe(200);
  });

  it("yöneticinin ilk şifresi komut satırından üretilen linkle belirlenir", async () => {
    const [admin] = await database.db
      .insert(users)
      .values({ email: "ilk@platform.test", name: "İlk", isSuperAdmin: true })
      .returning();
    expect((await login("ilk@platform.test", "herhangi-bir-sifre")).status).toBe(401); // şifresi yok
    const token = await createResetToken(database.db, admin!.id, null);
    expect((await app.call("POST", `/api/tokens/${token}/accept`, { body: { password: "yonetici-sifresi-1" } })).status).toBe(200);
    expect((await login("ilk@platform.test", "yonetici-sifresi-1")).status).toBe(200);
  });
});
