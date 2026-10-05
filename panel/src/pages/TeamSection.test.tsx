// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TeamSection } from "./TeamSection";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "owner" as const };

/** Sahte sunucu: üyeler ve davetler bellekte; istekleri kaydeder. */
function server() {
  let members = [
    { id: "u1", name: "Serap", email: "serap@m.test", role: "owner", lastLoginAt: "2026-10-04T10:00:00Z" },
    { id: "u2", name: "Zeynep", email: "zeynep@m.test", role: "agent", lastLoginAt: null },
  ];
  let invites: unknown[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = url.replace("/api/tenants/t", "");
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") return json({ members, invites });
    if (path === "/invites") { invites = [{ id: "i1", email: "yeni@m.test", role: "agent", expiresAt: "2026-10-12T10:00:00Z" }]; return json({ link: "https://x.test/davet/ABC", expiresInDays: 7 }); }
    if (path === "/members/u2/reset-link") return json({ link: "https://x.test/sifre/XYZ", expiresInHours: 24 });
    if (method === "DELETE" && path === "/members/u2") { members = members.filter((m) => m.id !== "u2"); return json({ ok: true }); }
    if (method === "DELETE" && path === "/invites/i1") { invites = []; return json({ ok: true }); }
    return json({ error: "yok" }, 404);
  }));
  return calls;
}

it("üyeler listelenir; kendini çıkaramaz, başkasını onayla çıkarır", async () => {
  vi.stubGlobal("confirm", () => true);
  const calls = server();
  render(<TeamSection store={store} userId="u1" />);
  await screen.findByText("Zeynep");
  expect(screen.getByText(/henüz giriş yapmadı/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Ekipten çıkar: Serap" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Ekipten çıkar: Zeynep" }));
  await vi.waitFor(() => expect(screen.queryByText("Zeynep")).toBeNull());
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/members/u2")).toBe(true);
});

it("çıkarma onaylanmazsa hiçbir şey olmaz", async () => {
  vi.stubGlobal("confirm", () => false);
  const calls = server();
  render(<TeamSection store={store} userId="u1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Ekipten çıkar: Zeynep" }));
  expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
});

it("davet linki oluşur, gösterilir; bekleyen davet listelenir ve iptal edilir", async () => {
  const calls = server();
  render(<TeamSection store={store} userId="u1" />);
  await screen.findByText("Zeynep");
  fireEvent.change(screen.getByLabelText("E-posta"), { target: { value: " yeni@m.test " } });
  fireEvent.click(screen.getByRole("button", { name: "Davet linki oluştur" }));
  await screen.findByText(/yeni@m.test için davet linki/);
  expect((screen.getByLabelText("Link") as HTMLInputElement).value).toBe("https://x.test/davet/ABC");
  expect(calls.find((c) => c.path === "/invites")!.body).toEqual({ email: "yeni@m.test", role: "agent" });
  await screen.findByRole("button", { name: "Daveti iptal et: yeni@m.test" });
  fireEvent.click(screen.getByRole("button", { name: "Daveti iptal et: yeni@m.test" }));
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: /Daveti iptal et/ })).toBeNull());
});

it("şifre linki üretilir ve gösterilir", async () => {
  server();
  render(<TeamSection store={store} userId="u1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Şifre linki: Zeynep" }));
  await screen.findByText(/Zeynep için şifre linki/);
  expect((screen.getByLabelText("Link") as HTMLInputElement).value).toBe("https://x.test/sifre/XYZ");
  fireEvent.click(screen.getByRole("button", { name: "Kapat" }));
  expect(screen.queryByLabelText("Link")).toBeNull();
});
