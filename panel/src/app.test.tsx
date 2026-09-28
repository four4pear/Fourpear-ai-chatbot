// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, TokenInfo } from "./api";
import { App } from "./App";
import { safeReturnPath } from "./router";

const OWNER: Me = {
  user: { id: "u1", email: "sahip@maius.test", name: "Betül Erdek", isSuperAdmin: false },
  memberships: [
    { tenantId: "t1", slug: "maius", name: "MAIUS", role: "owner" },
    { tenantId: "t2", slug: "diger", name: "Diğer Mağaza", role: "agent" },
  ],
};
const AGENT: Me = {
  user: { id: "u2", email: "calisan@maius.test", name: "Ayşe D", isSuperAdmin: false },
  memberships: [{ tenantId: "t1", slug: "maius", name: "MAIUS", role: "agent" }],
};
const TOKENS: Record<string, TokenInfo> = {
  yeni: { kind: "invite", email: "yeni@maius.test", tenantName: "MAIUS", tenantSlug: "maius", role: "agent", hasAccount: false },
  mevcut: { kind: "invite", email: "ajans@test.test", tenantName: "MAIUS", tenantSlug: "maius", role: "agent", hasAccount: true },
  sifre: { kind: "reset", email: "calisan@maius.test", tenantName: null, tenantSlug: null, role: null, hasAccount: true },
};

/** Sahte sunucu: oturum durumu ve gelen istekleri tutar. */
let session: Me | null;
let requests: { method: string; path: string; body?: unknown }[];

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function fakeServer(url: string, init?: RequestInit) {
  const path = url.replace(/^\/api/, "");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ method, path, body });

  if (path === "/me") return session ? json(200, session) : json(401, { error: "Oturum açın" });
  if (path === "/auth/login") {
    if (body.password !== "dogru-sifre-123") return json(401, { error: "E-posta ya da şifre hatalı" });
    session = body.email === AGENT.user.email ? AGENT : OWNER;
    return json(200, session);
  }
  if (path === "/auth/logout") {
    session = null;
    return json(200, { ok: true });
  }
  const token = /^\/tokens\/([^/]+)(\/accept)?$/.exec(path);
  if (token) {
    const info = TOKENS[token[1]!];
    if (!info) return json(404, { error: "Link geçersiz, kullanılmış ya da süresi dolmuş" });
    if (!token[2]) return json(200, info);
    session = OWNER;
    return json(200, session);
  }
  return json(404, { error: "Bulunamadı" });
}

function open(path: string) {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

beforeEach(() => {
  session = null;
  requests = [];
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(fakeServer));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("giriş", () => {
  it("oturumsuz kişiyi girişe gönderir, girişten sonra istediği sayfaya döndürür", async () => {
    open("/m/maius/ayarlar");
    await screen.findByRole("heading", { name: "Giriş yapın" });
    expect(window.location.pathname + window.location.search).toBe("/giris?sonra=%2Fm%2Fmaius%2Fayarlar");

    fireEvent.change(screen.getByLabelText("E-posta"), { target: { value: "sahip@maius.test" } });
    fireEvent.change(screen.getByLabelText("Şifre"), { target: { value: "yanlis" } });
    fireEvent.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect((await screen.findByRole("alert")).textContent).toBe("E-posta ya da şifre hatalı");

    fireEvent.change(screen.getByLabelText("Şifre"), { target: { value: "dogru-sifre-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Giriş yap" }));
    await screen.findByRole("heading", { name: "Ayarlar" });
    expect(window.location.pathname).toBe("/m/maius/ayarlar");
  });

  it("başka siteye yönlendirme için kullanılamaz", () => {
    expect(safeReturnPath("//kotu.site/x")).toBe("/");
    expect(safeReturnPath("https://kotu.site")).toBe("/");
    expect(safeReturnPath("/\\kotu.site")).toBe("/");
    expect(safeReturnPath("/m/maius/ayarlar")).toBe("/m/maius/ayarlar");
  });

  it("ana sayfa son açılan mağazaya gider", async () => {
    session = OWNER;
    localStorage.setItem("lina.lastStore", "diger");
    open("/");
    await screen.findByRole("heading", { name: "Bekleyenler" });
    expect(window.location.pathname).toBe("/m/diger/bekleyenler");
  });
});

describe("ana düzen ve roller", () => {
  it("sahip tüm bölümleri görür; mağaza değiştirilince aynı bölüm açılır, yetkisi yoksa bekleyenlere geçer", async () => {
    session = OWNER;
    open("/m/maius/istatistik");
    await screen.findByRole("heading", { name: "İstatistik" });
    const menu = screen.getByRole("navigation", { name: "Ana menü" });
    for (const name of ["Bekleyenler", "Tüm sohbetler", "İstatistik", "Ayarlar"]) {
      expect(within(menu).getByRole("link", { name })).toBeTruthy();
    }
    expect(within(menu).getByRole("link", { name: "İstatistik" }).getAttribute("aria-current")).toBe("page");

    // "Diğer Mağaza"da çalışan: İstatistik yok, bekleyenlere geçer.
    fireEvent.change(screen.getByLabelText("Mağaza"), { target: { value: "diger" } });
    await screen.findByRole("heading", { name: "Bekleyenler" });
    expect(window.location.pathname).toBe("/m/diger/bekleyenler");
  });

  it("çalışan sahip bölümlerini menüde görmez, adresle açarsa yetki uyarısı alır", async () => {
    session = AGENT;
    open("/m/maius/bekleyenler");
    await screen.findByRole("heading", { name: "Bekleyenler" });
    const menu = screen.getByRole("navigation", { name: "Ana menü" });
    expect(within(menu).queryByRole("link", { name: "Ayarlar" })).toBeNull();
    expect(within(menu).queryByRole("link", { name: "İstatistik" })).toBeNull();
    cleanup();

    open("/m/maius/ayarlar");
    await screen.findByRole("heading", { name: "Bu sayfayı görme yetkiniz yok" });
  });

  it("üyesi olmadığı mağaza bulunamadı olarak görünür", async () => {
    session = AGENT;
    open("/m/baskasi/bekleyenler");
    await screen.findByRole("heading", { name: "Sayfa bulunamadı" });
  });

  it("çıkış yapınca oturum kapanır ve girişe döner", async () => {
    session = OWNER;
    open("/m/maius/bekleyenler");
    await screen.findByRole("heading", { name: "Bekleyenler" });
    fireEvent.click(screen.getAllByRole("button", { name: "Hesap: Betül Erdek" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Çıkış yap" }));
    await screen.findByRole("heading", { name: "Giriş yapın" });
    expect(requests.some((r) => r.path === "/auth/logout" && r.method === "POST")).toBe(true);
  });
});

describe("davet ve şifre linkleri", () => {
  it("yeni kişi ad ve şifreyle hesap açar; şifreler tutmazsa sunucuya gitmeden uyarır", async () => {
    open("/davet/yeni");
    await screen.findByRole("heading", { name: "MAIUS ekibine katılın" });
    expect(screen.getByText(/çalışan olarak davet edildi/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Adınız"), { target: { value: "Yeni Kişi" } });
    fireEvent.change(screen.getByLabelText("Şifre"), { target: { value: "yeni-sifre-12345" } });
    fireEvent.change(screen.getByLabelText("Şifre (tekrar)"), { target: { value: "baska-sifre-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Hesabımı oluştur ve katıl" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Şifreler birbirini tutmuyor.");
    expect(requests.some((r) => r.path.endsWith("/accept"))).toBe(false);

    fireEvent.change(screen.getByLabelText("Şifre (tekrar)"), { target: { value: "yeni-sifre-12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Hesabımı oluştur ve katıl" }));
    await screen.findByRole("heading", { name: "Bekleyenler" });
    expect(window.location.pathname).toBe("/m/maius/bekleyenler");
    expect(requests.find((r) => r.path.endsWith("/accept"))!.body).toEqual({ name: "Yeni Kişi", password: "yeni-sifre-12345" });
  });

  it("hesabı olan kişiye sadece kendi şifresini sorar", async () => {
    open("/davet/mevcut");
    await screen.findByText(/zaten bir hesabınız var/);
    expect(screen.queryByLabelText("Adınız")).toBeNull();
    expect(screen.queryByLabelText("Şifre (tekrar)")).toBeNull();
    expect(screen.getByLabelText("Şifreniz")).toBeTruthy();
  });

  it("şifre linki yeni şifre ister", async () => {
    open("/sifre/sifre");
    await screen.findByRole("heading", { name: "Yeni şifre belirleyin" });
    expect(screen.getByLabelText("Şifre (tekrar)")).toBeTruthy();
  });

  it("geçersiz linkte açıklama gösterir", async () => {
    open("/davet/yok");
    await screen.findByRole("heading", { name: "Link kullanılamıyor" });
    expect(screen.getByText("Link geçersiz, kullanılmış ya da süresi dolmuş")).toBeTruthy();
  });
});
