// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
vi.mock("../session", () => ({ useSession: () => ({ me: { user: { id: "u1", name: "Serap", email: "s@m.test", isSuperAdmin: false }, memberships: [] } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "owner" as const };

/** Sahte sunucu: PATCH ile gelen ayarı uygular. */
const BASE = {
  botEnabled: true, botHoursOnly: false, businessHours: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "17:00" },
  notes: "", texts: { unsupported: "", failure: "" },
  defaultTexts: { unsupported: "Şu an yazılı mesajları ve fotoğrafları anlayabiliyorum.", failure: "Üzgünüm, şu an sorunuza cevap veremiyorum." },
  returnsPlaybook: "",
  deliveryDays: null as { min: number; max: number } | null, deliveryRange: [1, 90],
  limits: { replyDelaySeconds: 30, maxReplyWaitSeconds: 180, dailyMessageLimit: 200, dailyStoreMessageLimit: 3000 },
  limitRanges: { replyDelaySeconds: [0, 120], maxReplyWaitSeconds: [10, 600], dailyMessageLimit: [10, 2000], dailyStoreMessageLimit: [100, 50000] },
};
let alerts: { id: string; topic: string; description: string; createdAt: string }[] = [];
const resolved: string[] = [];
function server(initial: typeof BASE = BASE) {
  let state = initial;
  const patched: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes("/knowledge-alerts")) {
      if (init.method === "POST") { resolved.push(url); alerts = []; return json({ ok: true }); }
      return json({ alerts });
    }
    if (init.method === "PATCH") {
      const b = JSON.parse(String(init.body));
      patched.push(b);
      // Sunucudaki gibi: metinler birleşir, sınırlar tek tek gelir.
      const { texts, deliveryDays, ...rest } = b;
      const limits = { ...state.limits, ...Object.fromEntries(Object.keys(state.limits).filter((k) => k in rest).map((k) => [k, rest[k]])) };
      state = { ...state, ...rest, ...("deliveryDays" in b && { deliveryDays }), limits, ...(texts && { texts: { ...state.texts, ...texts } }), ...("returnsPlaybook" in rest && { returnsPlaybook: rest.returnsPlaybook.trim() }), ...("notes" in rest && { notes: rest.notes.trim() }) };
    }
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

it("Lina'ya notlar yazılıp kaydedilir; değişmediyse düğme kapalı", async () => {
  const patched = server();
  render(<SettingsPage store={store} />);
  const save = await screen.findByRole("button", { name: "Notları kaydet" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Lina'ya notlar" }), { target: { value: "Bu hafta kargoda gecikme var." } });
  expect((save as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(save);
  await screen.findByText("Notlar kaydedildi; Lina bir sonraki mesajda okur.");
  expect(patched).toEqual([{ notes: "Bu hafta kargoda gecikme var." }]);
  expect((screen.getByRole("button", { name: "Notları kaydet" }) as HTMLButtonElement).disabled).toBe(true);
});

it("müşteriye giden metinler: hazır metin yer tutucu olarak görünür; yazılan metin kaydedilir, silinen hazır metne döner", async () => {
  const patched = server();
  render(<SettingsPage store={store} />);
  const failure = await screen.findByLabelText("Teknik bir hata olup cevap verilemeyince");
  expect((failure as HTMLTextAreaElement).placeholder).toBe("Üzgünüm, şu an sorunuza cevap veremiyorum.");
  fireEvent.change(failure, { target: { value: "Şu an cevap veremiyorum, ekip dönecek." } });
  fireEvent.click(screen.getByRole("button", { name: "Metinleri kaydet" }));
  await screen.findByText("Metinler kaydedildi.");
  expect(patched.at(-1)).toEqual({ texts: { unsupported: "", failure: "Şu an cevap veremiyorum, ekip dönecek." } });
  // Metni silip kaydedince boş gider (sunucu hazır metne döner).
  fireEvent.change(screen.getByLabelText("Teknik bir hata olup cevap verilemeyince"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Metinleri kaydet" }));
  await vi.waitFor(() => expect(patched).toHaveLength(2));
  expect(patched[1]).toEqual({ texts: { unsupported: "", failure: "" } });
});

it("cevap hızı ve sınırlar: sayılar değiştirilip kaydedilir", async () => {
  const patched = server();
  render(<SettingsPage store={store} />);
  const daily = await screen.findByLabelText("Bir müşteri günde en fazla");
  expect((daily as HTMLInputElement).value).toBe("200");
  fireEvent.change(daily, { target: { value: "120" } });
  fireEvent.change(screen.getByLabelText("Cevap bekleme süresi"), { target: { value: "20" } });
  fireEvent.click(screen.getByRole("button", { name: "Sınırları kaydet" }));
  await screen.findByText("Sınırlar kaydedildi.");
  expect(patched).toEqual([{ replyDelaySeconds: 20, maxReplyWaitSeconds: 180, dailyMessageLimit: 120, dailyStoreMessageLimit: 3000 }]);
});

it("iade el kitabı kaydedilir", async () => {
  const patched = server();
  render(<SettingsPage store={store} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "İade el kitabı" }), { target: { value: "Önce müşteriyi dinle." } });
  fireEvent.click(screen.getByRole("button", { name: "El kitabını kaydet" }));
  await screen.findByText("İade el kitabı kaydedildi.");
  expect(patched).toEqual([{ returnsPlaybook: "Önce müşteriyi dinle." }]);
});

it("kaynak çelişkisi uyarısı görünür ve 'Çözüldü' ile kapanır; uyarı yoksa bölüm de yok", async () => {
  alerts = [];
  server();
  render(<SettingsPage store={store} />);
  await screen.findByRole("button", { name: "Notları kaydet" });
  expect(screen.queryByText("Mağaza bilgilerinde çelişki")).toBeNull();
  cleanup();

  alerts = [{ id: "a1", topic: "İade süresi", description: "Politika 14 gün, SSS 30 gün diyor.", createdAt: "2026-10-07T10:00:00Z" }];
  resolved.length = 0;
  server();
  render(<SettingsPage store={store} />);
  await screen.findByText("Politika 14 gün, SSS 30 gün diyor.");
  fireEvent.click(screen.getByRole("button", { name: "Çözüldü: İade süresi" }));
  await screen.findByText('"İade süresi" çözüldü olarak işaretlendi.');
  expect(resolved).toEqual(["/api/tenants/t/knowledge-alerts/a1/resolve"]);
  expect(screen.queryByText("Politika 14 gün, SSS 30 gün diyor.")).toBeNull();
});

it("teslimat süresi kuralı: açılıp 7-14 yazılır ve kaydedilir; kapatılınca boş gider", async () => {
  const patched = server();
  render(<SettingsPage store={store} />);
  const toggle = await screen.findByRole("switch", { name: "Teslimat süresi kuralı" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByLabelText("En az (gün)")).toBeNull();
  fireEvent.click(toggle);
  expect((screen.getByLabelText("En az (gün)") as HTMLInputElement).value).toBe("7");
  expect((screen.getByLabelText("En çok (gün)") as HTMLInputElement).value).toBe("14");
  fireEvent.click(screen.getByRole("button", { name: "Teslimat süresini kaydet" }));
  await screen.findByText("Teslimat süresi kaydedildi.");
  expect(patched).toEqual([{ deliveryDays: { min: 7, max: 14 } }]);
  // Kapatınca kural silinir.
  fireEvent.click(screen.getByRole("switch", { name: "Teslimat süresi kuralı" }));
  fireEvent.click(screen.getByRole("button", { name: "Teslimat süresini kaydet" }));
  await screen.findByText("Teslimat süresi kuralı kapatıldı.");
  expect(patched.at(-1)).toEqual({ deliveryDays: null });
});

