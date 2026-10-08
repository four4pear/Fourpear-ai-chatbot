// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountPage } from "./AccountPage";

vi.mock("../session", () => ({
  useSession: () => ({ me: { user: { id: "u1", name: "Serap", email: "serap@maius.test", isSuperAdmin: false }, memberships: [] }, errorMessage: (e: unknown) => (e instanceof Error ? e.message : "Hata") }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fill(current: string, next: string, again: string) {
  fireEvent.change(screen.getByLabelText("Mevcut şifre"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("Yeni şifre"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Yeni şifre (tekrar)"), { target: { value: again } });
}

it("iki yeni şifre farklıysa istek gitmez", async () => {
  const fetchMock = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountPage />);
  fill("eski-sifre-123", "yeni-sifre-12345", "baska-sifre-12345");
  fireEvent.click(screen.getByRole("button", { name: "Şifreyi değiştir" }));
  await screen.findByText("Yeni şifre iki kez aynı yazılmalı.");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("şifre değişir: doğru istek gider, alanlar boşalır, başarı yazılır", async () => {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => { sent.push([url, JSON.parse(String(init.body))]); return json({ ok: true }); }));
  render(<AccountPage />);
  fill("eski-sifre-123", "yeni-sifre-12345", "yeni-sifre-12345");
  fireEvent.click(screen.getByRole("button", { name: "Şifreyi değiştir" }));
  await screen.findByText("Şifreniz değiştirildi.");
  expect(sent).toEqual([["/api/auth/password", { currentPassword: "eski-sifre-123", newPassword: "yeni-sifre-12345" }]]);
  expect((screen.getByLabelText("Mevcut şifre") as HTMLInputElement).value).toBe("");
});

it("sunucu reddederse sebebi yazılır, başarı yazılmaz", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Mevcut şifre hatalı" }, 401)));
  render(<AccountPage />);
  fill("yanlis-sifre-123", "yeni-sifre-12345", "yeni-sifre-12345");
  fireEvent.click(screen.getByRole("button", { name: "Şifreyi değiştir" }));
  await screen.findByText("Mevcut şifre hatalı");
  expect(screen.queryByText("Şifreniz değiştirildi.")).toBeNull();
});
