// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TestPage } from "./TestPage";
const store = { tenantId: "t", slug: "test", name: "Test", role: "owner" as const };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const reply = (text: string) => json({ replies: [text], runs: [], handoffs: [], demoHelp: [] });
const write = (text: string) => {
  fireEvent.change(screen.getByLabelText("Mesajınız"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
};

/** Sahte sunucu: ders listesi boş; test sohbeti isteklerini verilen fonksiyon cevaplar. */
function server(test: (init: RequestInit) => Response | Promise<Response>, extra: Record<string, (init: RequestInit) => Response> = {}) {
  const testCalls: RequestInit[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace("/api/tenants/t", "");
    if (path === "/test") { testCalls.push(init); return test(init); }
    const key = `${init.method ?? "GET"} ${path}`;
    if (extra[key]) return extra[key](init);
    if (key === "GET /lessons") return json({ lessons: [] });
    return json({ error: "yok" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { testCalls, fetch, body: (i: number) => JSON.parse(String(testCalls[i]!.body)) };
}

it("shows a reply and resets the test conversation", async () => {
  server(() => reply("Kargo iki gün."));
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Kargo?");
  await screen.findByText("Kargo iki gün.");
  fireEvent.click(screen.getByRole("button", { name: "Yeni sohbet" }));
  expect(screen.queryByText("Kargo iki gün.")).toBeNull();
});

it("keeps the draft after an API error", async () => {
  server(() => json({ error: "Tekrar deneyin" }, 503));
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Merhaba");
  await screen.findByRole("alert");
  await waitFor(() => expect((screen.getByLabelText("Mesajınız") as HTMLTextAreaElement).value).toBe("Merhaba"));
});

it("answers consecutive messages once, after the customer stops writing", async () => {
  const s = server(() => reply("Siparişinize bakıyorum."));
  render(<TestPage store={store} replyDelayMs={80} />);
  write("Merhaba");
  expect(screen.getByRole("status").textContent).toContain("Lina bekliyor");
  write("siparişim gelmedi");
  write("#1045");
  await screen.findByText("Siparişinize bakıyorum.");
  expect(s.testCalls).toHaveLength(1);
  expect(s.body(0).history).toEqual([
    { role: "user", text: "Merhaba" },
    { role: "user", text: "siparişim gelmedi" },
    { role: "user", text: "#1045" },
  ]);
});

it("cancels the reply being prepared when a new message arrives", async () => {
  const signals: AbortSignal[] = [];
  const s = server((init) => {
    signals.push(init.signal!);
    if (signals.length > 1) return reply("İkisine birden cevap.");
    return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  });
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Merhaba");
  await screen.findByText(/cevap hazırlıyor/);
  write("iade nasıl yapılır?");
  await screen.findByText("İkisine birden cevap.");
  expect(signals[0]!.aborted).toBe(true);
  expect(s.body(1).history).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("'geri bildirim:' müşteri mesajı değil: kural önerilir, onaylanınca kaydedilir, son soru yeni kuralla tekrar sorulur", async () => {
  let answers = 0;
  const saved: unknown[] = [];
  const s = server(() => reply(++answers === 1 ? "Kaynaklarda tutarsızlık var." : "İnceleme en geç 14 gün sürer."), {
    "POST /test/feedback": (init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        feedback: "iade süresini direkt söyle: 14 gün inceleme",
        history: [{ role: "user", text: "İadem ne zaman yatar?" }, { role: "assistant", text: "Kaynaklarda tutarsızlık var." }],
      });
      return json({ summary: "Anladım: iade süresi doğrudan söylenecek.", lessons: ["Müşteri iade süresini sorduğunda: inceleme en geç 14 gün."], replaces: [] });
    },
    "POST /lessons": (init) => { saved.push(JSON.parse(String(init.body))); return json({ lessons: [] }, 201); },
  });
  render(<TestPage store={store} replyDelayMs={0} />);
  write("İadem ne zaman yatar?");
  await screen.findByText("Kaynaklarda tutarsızlık var.");

  write("Geri bildirim: iade süresini direkt söyle: 14 gün inceleme");
  await screen.findByText("Anladım: iade süresi doğrudan söylenecek.");
  expect(s.testCalls).toHaveLength(1); // geri bildirim Lina'ya müşteri mesajı olarak gitmedi
  fireEvent.change(screen.getByLabelText("Kural 1"), { target: { value: "Müşteri iade süresini sorduğunda: inceleme en geç 14 gün sürer." } });
  fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
  await screen.findByText(/Öğrenildi/);
  expect(saved).toEqual([
    { texts: ["Müşteri iade süresini sorduğunda: inceleme en geç 14 gün sürer."], replaces: [], feedback: "iade süresini direkt söyle: 14 gün inceleme" },
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Son soruyu tekrar sor" }));
  await screen.findByText("İnceleme en geç 14 gün sürer.");
  // Eski cevap Lina'ya gönderilmez; ekranda "önceki cevap" olarak kalır.
  expect(s.body(1).history).toEqual([{ role: "user", text: "İadem ne zaman yatar?" }]);
  expect(screen.getByText("Lina (önceki cevap)")).toBeTruthy();
});

it("öğrenilen dersler listelenir ve silinebilir", async () => {
  let lessons = [{ id: "l1", text: "İade süresi: 14 gün inceleme." }];
  vi.stubGlobal("confirm", () => true);
  server(() => reply("x"), {
    "GET /lessons": () => json({ lessons }),
    "DELETE /lessons/l1": () => { lessons = []; return json({ ok: true }); },
  });
  render(<TestPage store={store} replyDelayMs={0} />);
  await screen.findByText("İade süresi: 14 gün inceleme.");
  fireEvent.click(screen.getByRole("button", { name: "Dersi sil: İade süresi: 14 gün inceleme." }));
  await screen.findByText("Henüz ders yok.");
});

it("deneme siparişleri kutu işaretlenince sağda listelenir; tıklayınca örnek mesaj yazılır", async () => {
  server(() => reply("x"), {
    "GET /test/demo-orders": () => json({ scenarios: [{ order: "MO-9013", label: "iade 50 gündür yatmadı", sample: "MO-9013 iadem 50 gündür yatmadı" }] }),
  });
  render(<TestPage store={store} replyDelayMs={0} />);
  expect(screen.queryByText("Deneme siparişleri")).toBeNull();
  fireEvent.click(screen.getByLabelText("Deneme siparişlerini kullan"));
  fireEvent.click(await screen.findByRole("button", { name: "MO-9013 iade 50 gündür yatmadı" }));
  expect((screen.getByLabelText("Mesajınız") as HTMLTextAreaElement).value).toBe("MO-9013 iadem 50 gündür yatmadı");
});

it("Lina ekibe sorarsa soru kartı çıkar; ekip olarak cevaplanınca cevap Lina'ya 'team' olarak gider", async () => {
  let n = 0;
  const s = server(() => ++n === 1
    ? json({ replies: ["Hemen kontrol ediyorum."], runs: [], handoffs: [], demoHelp: [], teamQuestions: [{ question: "Hediye paketi var mı?", context: "" }] })
    : reply("Evet, hediye paketi ücretsiz."));
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Hediye paketi yapıyor musunuz?");
  await screen.findByText("Hediye paketi var mı?");
  fireEvent.change(screen.getByLabelText("Ekibin cevabı"), { target: { value: "Evet, ücretsiz." } });
  fireEvent.click(screen.getByRole("button", { name: "Ekip olarak cevapla" }));
  await screen.findByText("Evet, hediye paketi ücretsiz.");
  expect(s.body(1).history).toEqual([
    { role: "user", text: "Hediye paketi yapıyor musunuz?" },
    { role: "assistant", text: "Hemen kontrol ediyorum." },
    { role: "team", question: "Hediye paketi var mı?", text: "Evet, ücretsiz." },
  ]);
});

it("son cevabın karar özeti: kime soruldu, ekibe ne gitti, harcama", async () => {
  server(() => json({
    replies: ["Çok üzgünüm, hemen ilgileniyorum."],
    runs: [
      { agent: "lina", question: null, answer: "Çok üzgünüm, hemen ilgileniyorum.", error: null },
      { agent: "returns", question: "[Hasarlı ürün] Ürün hasarlı geldi", answer: "EKİBE: iletildi", error: null },
      { agent: "memory", question: null, answer: null, error: null },
    ],
    handoffs: [], demoHelp: [],
    notifications: [{ label: "İade: ekip kararı gerekiyor", important: true, orders: ["#MO-9010"], issues: ["Hasarlı ürün bildirildi."] }],
    summary: { costUsd: 0.0312, memoryCostUsd: 0.002, durationMs: 14200, apiCalls: 4 },
  }));
  render(<TestPage store={store} replyDelayMs={0} />);
  expect(screen.getByText(/İlk cevaptan sonra burada görünecek/)).toBeTruthy();
  write("MO-9010 hasarlı geldi");
  await screen.findByText("Çok üzgünüm, hemen ilgileniyorum.");
  expect(screen.getByText("İade uzmanı")).toBeTruthy();
  expect(screen.queryByText("memory")).toBeNull(); // müşteri kartı uzman değildir
  expect(screen.getByText("Önemli bildirim:").parentElement!.textContent).toBe("Önemli bildirim: İade: ekip kararı gerekiyor (#MO-9010)");
  expect(screen.getByText("Hasarlı ürün bildirildi.")).toBeTruthy();
  expect(screen.getByText("Yaklaşık $0.0312 · 14 sn · 4 yapay zekâ çağrısı")).toBeTruthy();
  expect(screen.getByText(/Müşteri kartı güncellemesi ayrıca \$0\.0020/)).toBeTruthy();
});

it("karar özeti: Lina tek başına cevapladıysa ve ekibe bir şey gitmediyse bunu söyler", async () => {
  server(() => json({ replies: ["Kargo iki gün."], runs: [{ agent: "lina", question: null, answer: "Kargo iki gün.", error: null }], handoffs: [], demoHelp: [], notifications: [], summary: { costUsd: 0.004, memoryCostUsd: null, durationMs: 3600, apiCalls: 1 } }));
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Kargo?");
  await screen.findByText("Kargo iki gün.");
  expect(screen.getByText("Lina kendi bilgisiyle cevapladı; uzmana sormadı.")).toBeTruthy();
  expect(screen.getByText("Ekibe bir şey gitmedi.")).toBeTruthy();
  expect(screen.getByText("Yaklaşık $0.0040 · 4 sn · 1 yapay zekâ çağrısı")).toBeTruthy();
});

it("ders yerinde düzenlenir", async () => {
  let lessons = [{ id: "l1", text: "Eski metin." }];
  const patched: unknown[] = [];
  server(() => reply("x"), {
    "GET /lessons": () => json({ lessons }),
    "PATCH /lessons/l1": (init) => { const body = JSON.parse(String(init.body)); patched.push(body); lessons = [{ id: "l1", text: body.text }]; return json({ lesson: lessons[0] }); },
  });
  render(<TestPage store={store} replyDelayMs={0} />);
  fireEvent.click(await screen.findByRole("button", { name: "Dersi düzenle: Eski metin." }));
  fireEvent.change(screen.getByLabelText("Dersin metni"), { target: { value: "Yeni metin." } });
  fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
  await screen.findByText("Yeni metin.");
  expect(patched).toEqual([{ text: "Yeni metin." }]);
});
