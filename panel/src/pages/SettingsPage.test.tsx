// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
vi.mock("../session", () => ({ useSession: () => ({ me: { user: { id: "u1", name: "Serap", email: "s@m.test", isSuperAdmin: false }, memberships: [] } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "owner" as const };

/** Sahte sunucu: PATCH ile gelen ayarı uygular. */
function server(initial = { botEnabled: true, botHoursOnly: false, businessHours: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "17:00" } }) {
  let state = initial;
  const patched: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === "PATCH") { const b = JSON.parse(String(init.body)); patched.push(b); state = { ...state, ...b }; }
    return json(state);
  }));
  return patched;
}

it("Lina açıkken kapatılır (onayla), kapalıyken tek tıkla açılır", async () => {
  vi.stubGlobal("confirm", () => true);
  const patched = server();
  render(<SettingsPage store={store} />);
  await screen.findByText("Lina açık: müşterilere cevap veriyor.");
  const bot = screen.getByRole("switch", { name: "Lina" });
  expect(bot.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(bot);
  await screen.findByText("Lina kapalı: hiçbir müşteriye cevap vermiyor.");
  expect(screen.getByRole("switch", { name: "Lina" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("switch", { name: "Lina" }));
  await screen.findByText("Lina açık: müşterilere cevap veriyor.");
  expect(patched).toEqual([{ botEnabled: false }, { botEnabled: true }]);
});

it("kapatma onaylanmazsa hiçbir şey değişmez", async () => {
  vi.stubGlobal("confirm", () => false);
  const patched = server();
  render(<SettingsPage store={store} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Lina" }));
  expect(patched).toEqual([]);
});

it("mesai saatleri düzenlenip kaydedilir; 'yalnızca mesai saatlerinde' ayrıca açılır", async () => {
  const patched = server();
  render(<SettingsPage store={store} />);
  const save = await screen.findByRole("button", { name: "Mesai saatlerini kaydet" });
  expect((save as HTMLButtonElement).disabled).toBe(true); // değişiklik yok
  fireEvent.change(screen.getByLabelText("Bitiş"), { target: { value: "18:00" } });
  const sunday = screen.getByRole("button", { name: "Paz" });
  expect(sunday.getAttribute("aria-pressed")).toBe("false");
  expect(sunday.textContent).toContain("Kapalı");
  fireEvent.click(sunday); // pazar açılır
  expect(sunday.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Pzt" }).textContent).toContain("10:00–18:00");
  fireEvent.click(save);
  await screen.findByText("Mesai saatleri kaydedildi.");
  expect(patched).toEqual([{ businessHours: { days: [1, 2, 3, 4, 5, 6, 0], start: "10:00", end: "18:00" } }]);

  fireEvent.click(screen.getByRole("switch", { name: "Lina yalnızca mesai saatlerinde cevap versin" }));
  await screen.findByText("Lina artık yalnızca mesai saatlerinde cevap verecek.");
  expect(patched.at(-1)).toEqual({ botHoursOnly: true });
  expect(screen.getByText(/mesai başlayınca Lina bekleyen mesajlara cevap verir/)).toBeTruthy();
});
