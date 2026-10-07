// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationPane } from "./ConversationPane";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "agent" as "agent" | "owner" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const at = "2026-10-03T10:00:00Z";
const soon = () => new Date(Date.now() + 23 * 60 * 60_000 + 30_000).toISOString();
const render_ = (over: { store?: typeof store; userId?: string } = {}) =>
  render(<ConversationPane store={over.store ?? store} conversationId="c1" userId={over.userId ?? "u1"} backTo="/m/s/sohbetler" />);

const messages = [
  { id: "m1", sender: "customer", type: "text", text: "Ürün hasarlı geldi", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m2", sender: "customer", type: "image", text: null, createdAt: at, author: null, hasImage: true, sendError: null },
  { id: "m3", sender: "bot", type: "text", text: "Çok üzgünüm, hemen ilgileniyorum.", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m4", sender: "system", type: "team_answer", text: "Soru: Değişim olur mu?\nEkibin cevabı: Evet.", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m5", sender: "system", type: "note", text: "Zeynep konuşmayı devraldı", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m6", sender: "agent", type: "text", text: "Merhaba, yeni ürünü yarın gönderiyoruz.", createdAt: at, author: { name: "Zeynep" }, hasImage: false, sendError: "{\"error\":{\"code\":131047}}" },
  { id: "m7", sender: "customer", type: "audio", text: null, createdAt: at, author: null, hasImage: false, sendError: null },
];
const full = {
  conversation: { id: "c1", status: "waiting", assignedTo: null, canReply: false, windowOpenUntil: soon() },
  customer: { name: "Zehra", phone: "+90 533 444 55 66", firstSeenAt: "2026-09-20T09:00:00Z" },
  messages,
  expertCalls: [{ agent: "returns", question: "[Hasarlı ürün] Ürün hasarlı geldi", answer: "EKİBE: iletildi", createdAt: at }],
  handoffs: [
    { reason: "complaint", summary: "Müşteri öfkeli; hasarlı ürün.", status: "open", createdAt: at, resolvedAt: null },
    { reason: "customer_request", summary: "Eski devir", status: "resolved", createdAt: "2026-09-25T10:00:00Z", resolvedAt: "2026-09-25T11:00:00Z" },
  ],
  notifications: [
    { id: "n1", kind: "return_review", label: "İade: ekip kararı gerekiyor", important: true, status: "open", orderNames: ["#MO-9010"], issues: ["Hasarlı ürün bildirildi."], question: "Ürün hasarlı", answer: "", updatedAt: "2026-10-03T12:05:00.000Z" },
    { id: "n2", kind: "order_question", label: "Sipariş sorusu", important: false, status: "open", orderNames: [], issues: [], question: "", answer: "", updatedAt: null },
  ],
  teamQuestions: [{ id: "q1", question: "Hasarlı üründe kargo ücreti bizden mi?", context: "Müşteri hasarlı ürün gönderdi", customerMessage: "kargo ücretini kim öder", createdAt: at }],
};

/** Sahte sunucu: konuşma ayrıntısını verir, POST isteklerini kaydeder (cevap verilince Lina'nın sorusu listeden düşer). */
function server(detail: Record<string, unknown> = full, reply: Record<string, unknown> = { ok: true }, fail?: { path: string; status: number; error: string }) {
  let current = structuredClone(detail) as typeof full;
  const posted: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") {
      posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split("/").at(-1)!;
      if (fail?.path === path) return json({ error: fail.error }, fail.status);
      if (path === "done") current.notifications = current.notifications.filter((n) => n.id !== "n1");
      if (path === "answer") current.teamQuestions = [];
      if (path === "takeover") current.conversation = { ...current.conversation, status: "human", assignedTo: { id: "u1", name: "Zeynep" } as never, canReply: true };
      if (path === "release") current.conversation = { ...current.conversation, status: "bot", assignedTo: null, canReply: false };
      return json(path === "answer" ? reply : { ok: true });
    }
    return json(current);
  }));
  return posted;
}

it("konuşma: mesajlar kimin yazdığıyla, iç notlar ayrı; Lina'nın özeti, devir ve iletilenler görünür", async () => {
  server();
  render_();
  await screen.findByText("Ürün hasarlı geldi");
  expect(screen.getByRole("heading", { name: "Zehra", level: 2 })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/^Ekibi bekliyor · henüz kimse devralmadı · 24 saat penceresinde 2[23] sa kaldı$/);
  expect(document.title).toBe("Zehra · Betül Saday · Lina Panel");
  expect(screen.getByRole("link", { name: "Listeye dön" }).getAttribute("href")).toBe("/m/s/sohbetler");
  expect(screen.getByAltText("Müşterinin gönderdiği fotoğraf").getAttribute("src")).toBe("/api/tenants/t/media/m2");
  expect(screen.getByText("Çok üzgünüm, hemen ilgileniyorum.").closest(".bubble")!.className).toBe("bubble ours");
  expect(screen.getByText("Ürün hasarlı geldi").closest(".bubble")!.className).toBe("bubble");
  expect(screen.getByText("Merhaba, yeni ürünü yarın gönderiyoruz.").closest(".bubble")!.className).toBe("bubble ours agent");
  expect(screen.getByText(/Ekibin Lina’ya cevabı \(müşteri görmez\)/)).toBeTruthy();
  expect(screen.getByText(/Zeynep konuşmayı devraldı/)).toBeTruthy();
  expect(screen.getByText("Ekip (Zeynep)")).toBeTruthy();
  // WhatsApp'ın ham hata metni ekibe gösterilmez.
  expect(screen.getByText("Müşteriye gönderilemedi. Mesajı yeniden yazıp gönderin.")).toBeTruthy();
  expect(screen.queryByText(/131047/)).toBeNull();
  expect(screen.getByText("Ses mesajı")).toBeTruthy();
  // Lina'nın özeti: devir sebebi + özeti ve ekibe iletilen talep.
  const summary = screen.getByText("Lina’nın özeti").parentElement!;
  expect(within(summary).getByText("Şikayet")).toBeTruthy();
  expect(within(summary).getByText(/Müşteri öfkeli; hasarlı ürün\./)).toBeTruthy();
  expect(within(summary).getByText("İade: ekip kararı gerekiyor")).toBeTruthy();
  expect(within(summary).getByText("Hasarlı ürün bildirildi.")).toBeTruthy();
  expect(screen.queryByText("Sipariş sorusu")).toBeNull(); // sessiz kayıt ekibin işi değildir
  // Müşteri kartı: telefon, siparişler, uzman soruları, önceki devirler.
  const card = screen.getByLabelText("Müşteri kartı", { selector: "aside" });
  expect(within(card).getByText("+90 533 444 55 66")).toBeTruthy();
  expect(within(card).getByText("#MO-9010")).toBeTruthy();
  expect(within(card).getByText(/^İade uzmanı/)).toBeTruthy();
  expect(within(card).getByText(/Temsilci istedi/)).toBeTruthy();
});

it("Lina'nın sorusu konuşmanın içinde cevaplanır; mağaza sahibi 'öğret' diyebilir", async () => {
  const posted = server(full, { ok: true, taught: true, windowClosed: false, relay: "lina" });
  render_({ store: { ...store, role: "owner" } });
  const ask = await screen.findByLabelText("Lina’nın sorusu");
  expect(within(ask).getByText("Hasarlı üründe kargo ücreti bizden mi?")).toBeTruthy();
  expect(within(ask).getByText("kargo ücretini kim öder")).toBeTruthy();
  expect(within(ask).getByText("Müşteri hasarlı ürün gönderdi")).toBeTruthy();
  fireEvent.change(within(ask).getByLabelText("Cevabınız"), { target: { value: "Evet, kargo bizden." } });
  fireEvent.click(within(ask).getByLabelText(/Lina’ya öğret/));
  fireEvent.click(within(ask).getByRole("button", { name: "Cevabı gönder" }));
  await screen.findByText(/Lina cevabınızı müşteriye iletiyor\. Bu bilgi Lina'ya da öğretildi\./);
  expect(posted).toEqual([{ url: "/api/tenants/t/team-questions/q1/answer", body: { answer: "Evet, kargo bizden.", teach: true } }]);
  await vi.waitFor(() => expect(screen.queryByLabelText("Lina’nın sorusu")).toBeNull());
});

it("çalışan cevaplar ama 'Lina'ya öğret' seçeneğini görmez", async () => {
  server();
  render_();
  await screen.findByLabelText("Lina’nın sorusu");
  expect(screen.queryByLabelText(/Lina’ya öğret/)).toBeNull();
});

it("cevap sonrası ekran Lina'nın iletip iletemeyeceğini söyler; öğretilmediyse sebebini yazar", async () => {
  server(full, { ok: true, taught: false, windowClosed: false, relay: "in_team" });
  const { unmount } = render_();
  fireEvent.change(await screen.findByLabelText("Cevabınız"), { target: { value: "Evet." } });
  fireEvent.click(screen.getByRole("button", { name: "Cevabı gönder" }));
  await screen.findByText(/konuşma ekipte, Lina müşteriye iletmeyecek/);
  expect(screen.queryByText(/Lina cevabınızı müşteriye iletiyor/)).toBeNull();
  unmount();

  server(full, { ok: true, taught: false, teachSkipped: "specific", windowClosed: false, relay: "lina" });
  render_({ store: { ...store, role: "owner" } });
  fireEvent.change(await screen.findByLabelText("Cevabınız"), { target: { value: "MO-9013 yattı." } });
  fireEvent.click(screen.getByLabelText(/Lina’ya öğret/));
  fireEvent.click(screen.getByRole("button", { name: "Cevabı gönder" }));
  await screen.findByText(/Lina'ya öğretilmedi: soru ya da cevapta sipariş numarası ya da telefon var/);
  expect(screen.queryByText(/Bu bilgi Lina'ya da öğretildi/)).toBeNull();
});

it("ekibe iletilen talep 'Tamamlandı' denince kapanır (görülen hâlin zamanıyla); yanlış basıldıysa geri alınır", async () => {
  const posted = server();
  render_();
  fireEvent.click(await screen.findByRole("button", { name: "Tamamlandı: İade: ekip kararı gerekiyor" }));
  const notice = await screen.findByText(/İade: ekip kararı gerekiyor: talep tamamlandı\./);
  expect(posted[0]).toEqual({ url: "/api/tenants/t/notifications/n1/done", body: { seenUpdatedAt: "2026-10-03T12:05:00.000Z" } });
  await vi.waitFor(() => expect(screen.queryByText("Hasarlı ürün bildirildi.")).toBeNull());
  fireEvent.click(within(notice).getByRole("button", { name: "Geri al" }));
  await screen.findByText("Talep yeniden açıldı.");
  expect(posted[1]!.url).toBe("/api/tenants/t/notifications/n1/reopen");
});

it("müşteri bu arada yeniden yazdıysa 'Tamamlandı' kapatmaz: nedeni yazar, talep kalır", async () => {
  server(full, { ok: true }, { path: "done", status: 409, error: "Bu talep siz bakarken güncellendi: müşteri yeni bir şey yazdı. Yeni hâline bakıp tekrar deneyin." });
  render_();
  fireEvent.click(await screen.findByRole("button", { name: /^Tamamlandı:/ }));
  await screen.findByText(/siz bakarken güncellendi/);
  expect(screen.getByText("Hasarlı ürün bildirildi.")).toBeTruthy();
});

/** Devral/geri ver/gönder isteklerini kaydeden basit konuşma. */
const simple = (status: string, assignedTo: { id: string; name: string } | null, canReply = false, extra: Record<string, unknown> = {}) => ({
  conversation: { id: "c1", status, assignedTo, canReply, windowOpenUntil: soon() },
  customer: { name: "Zehra", phone: "+90 533 444 55 66" },
  messages: [messages[0]], expertCalls: [], handoffs: [], notifications: [], teamQuestions: [], ...extra,
});

it("devral → yaz → Lina'ya geri ver", async () => {
  const posted = server(simple("waiting", null));
  render_();
  await screen.findByText("Ürün hasarlı geldi");
  // Devralmadan yazma kutusu kilitlidir ve nedenini söyler.
  const locked = screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement;
  expect(locked.disabled).toBe(true);
  expect(locked.placeholder).toBe("Önce devralın, sonra yazın…");
  fireEvent.click(screen.getByRole("button", { name: "Devral" }));
  await vi.waitFor(() => expect((screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Devral" })).toBeNull();
  expect(screen.getByRole("status").textContent).toMatch(/^Sizde · Lina susuyor/);

  fireEvent.change(screen.getByLabelText("Müşteriye mesajınız"), { target: { value: " Merhaba Zehra Hanım " } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
  await vi.waitFor(() => expect((screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement).value).toBe(""));

  fireEvent.click(screen.getByRole("button", { name: "Lina’ya geri ver" }));
  await screen.findByRole("button", { name: "Devral" });
  expect(posted.map((p) => [p.url.split("/").at(-1), p.body])).toEqual([
    ["takeover", undefined],
    ["messages", { text: "Merhaba Zehra Hanım" }],
    ["release", undefined],
  ]);
});

it("başkasının devraldığı konuşmada çalışan devralamaz ve geri veremez; mağaza sahibi yapabilir", async () => {
  server(simple("human", { id: "u2", name: "Ali" }));
  const { unmount } = render_();
  await screen.findByText(/Ekipte: Ali · Lina susuyor/);
  expect(screen.queryByRole("button", { name: "Devral" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Lina’ya geri ver" })).toBeNull();
  expect((screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement).placeholder).toMatch(/yalnızca devralan kişi yazabilir/);
  unmount();

  render_({ store: { ...store, role: "owner" } });
  await screen.findByRole("button", { name: "Devral" });
  expect(screen.getByRole("button", { name: "Lina’ya geri ver" })).toBeTruthy();
});

it("devralan kişi silinmişse (konuşma kimsede değil) çalışan da devralabilir ya da geri verebilir", async () => {
  server(simple("human", null));
  render_();
  await screen.findByRole("button", { name: "Devral" });
  expect(screen.getByRole("button", { name: "Lina’ya geri ver" })).toBeTruthy();
});

it("24 saat geçtiyse yazma kutusu kapanır ve nedeni yazar; gönderilemeyen mesajda taslak silinmez", async () => {
  server(simple("human", { id: "u1", name: "Zeynep" }, false, { conversation: { id: "c1", status: "human", assignedTo: { id: "u1", name: "Zeynep" }, canReply: false, windowOpenUntil: "2026-10-01T10:00:00Z" } }));
  const { unmount } = render_();
  await screen.findByText(/Müşterinin son mesajından 24 saat geçti/);
  expect(screen.queryByLabelText("Müşteriye mesajınız")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("WhatsApp yazma süresi doldu");
  expect(screen.getByRole("button", { name: "Lina’ya geri ver" })).toBeTruthy();
  unmount();

  server(simple("human", { id: "u1", name: "Zeynep" }, true), { ok: true }, { path: "messages", status: 502, error: "Mesaj WhatsApp'a gönderilemedi. Lütfen tekrar deneyin." });
  render_();
  fireEvent.change(await screen.findByLabelText("Müşteriye mesajınız"), { target: { value: "Merhaba" } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
  await screen.findByText("Mesaj WhatsApp'a gönderilemedi. Lütfen tekrar deneyin.");
  expect((screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement).value).toBe("Merhaba");
});

it("yüklenemezse sebebini yazar", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Konuşma bulunamadı" }, 404)));
  render_();
  await screen.findByText("Konuşma bulunamadı");
});

it("müşteri kartı düğmesi dar ekranda kartı açıp kapatır", async () => {
  server(simple("bot", null));
  render_();
  const toggle = await screen.findByRole("button", { name: "Müşteri kartı" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByLabelText("Müşteri kartı", { selector: "aside" }).className).toContain("open");
});
