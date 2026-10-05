// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "owner" as const };

it("Lina açıkken kapatılır (onayla), kapalıyken tek tıkla açılır", async () => {
  let enabled = true;
  const patched: unknown[] = [];
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === "PATCH") { const b = JSON.parse(String(init.body)); patched.push(b); enabled = b.botEnabled; }
    return json({ botEnabled: enabled });
  }));
  render(<SettingsPage store={store} />);
  await screen.findByText("Lina açık: müşterilere cevap veriyor.");
  fireEvent.click(screen.getByRole("button", { name: "Lina'yı kapat" }));
  await screen.findByText("Lina kapalı: hiçbir müşteriye cevap vermiyor.");
  fireEvent.click(screen.getByRole("button", { name: "Lina'yı aç" }));
  await screen.findByText("Lina açık: müşterilere cevap veriyor.");
  expect(patched).toEqual([{ botEnabled: false }, { botEnabled: true }]);
});

it("kapatma onaylanmazsa hiçbir şey değişmez", async () => {
  const calls: string[] = [];
  vi.stubGlobal("confirm", () => false);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => { calls.push(init.method ?? "GET"); return json({ botEnabled: true }); }));
  render(<SettingsPage store={store} />);
  fireEvent.click(await screen.findByRole("button", { name: "Lina'yı kapat" }));
  expect(calls).toEqual(["GET"]);
});
