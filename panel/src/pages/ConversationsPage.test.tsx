// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationPage, ConversationsPage } from "./ConversationsPage";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });
const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "agent" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const at = "2026-10-03T10:00:00Z";
const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, status: "bot", updatedAt: at, customer: { name, phone: "+90 532 000 00 00" }, assignedTo: null, openHandoff: null,
  lastMessage: { sender: "bot", type: "text", text: "Kargonuz yolda.", createdAt: at }, ...extra,
});

it("tüm sohbetler: müşteri, durum ve son mesajla listelenir; satır konuşmayı açar", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return json({ conversations: [
      row("c1", "Zehra", { status: "waiting", lastMessage: { sender: "customer", type: "text", text: "Temsilciyle görüşmek istiyorum", createdAt: at } }),
      row("c2", "Elif", { status: "human", assignedTo: { id: "u1", name: "Zeynep" }, lastMessage: { sender: "customer", type: "image", text: null, createdAt: at } }),
      row("c3", "Ayşe"),
      row("c4", "+90 532 000 00 00", { lastMessage: { sender: "system", type: "team_answer", text: "Soru: …\nEkibin cevabı: …", createdAt: at } }),
    ] });
  }));
  render(<ConversationsPage store={store} />);
  await screen.findByText("Müşteri: Temsilciyle görüşmek istiyorum");
  expect(urls).toEqual(["/api/tenants/t/conversations?view=all"]);
  expect(screen.getByText("Ekibi bekliyor")).toBeTruthy();
  expect(screen.getByText("Ekipte: Zeynep")).toBeTruthy();
  expect(screen.getByText("Müşteri: Fotoğraf")).toBeTruthy();
  expect(screen.getByText("Lina: Kargonuz yolda.")).toBeTruthy();
  // Ekibin Lina'ya iç cevabı müşteriye giden mesaj gibi görünmez; adı olmayan müşteride telefon bir kez yazılır.
  expect(screen.getByText("Ekip Lina’nın sorusunu cevapladı")).toBeTruthy();
  expect(screen.getAllByText("+90 532 000 00 00")).toHaveLength(4);
  expect(screen.getAllByRole("link")[0]!.getAttribute("href")).toBe("/m/s/sohbetler/c1");
  // 50'den az konuşma geldiyse daha eskisi yoktur.
  expect(screen.queryByRole("button", { name: "Daha eski sohbetler" })).toBeNull();
});

it("görünüm ve arama: 'Bende' ve 'Ekibi bekleyen' ayrı listelenir, arama sunucuya gider", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return json({ conversations: url.includes("q=") ? [] : url.includes("view=mine") ? [row("c2", "Elif")] : [row("c3", "Ayşe")] });
  }));
  render(<ConversationsPage store={store} />);
  await screen.findByText("Ayşe");
  fireEvent.click(screen.getByRole("button", { name: "Bende" }));
  await screen.findByText("Elif");
  expect(screen.queryByText("Ayşe")).toBeNull();
  fireEvent.change(screen.getByLabelText("Müşteri ara"), { target: { value: " zeh " } });
  await screen.findByText("Bu aramayla eşleşen konuşma yok.");
  fireEvent.click(screen.getByRole("button", { name: "Ekibi bekleyen" }));
  await vi.waitFor(() => expect(urls.at(-1)).toContain("view=waiting"));
  expect(urls).toContain("/api/tenants/t/conversations?view=mine");
  expect(urls).toContain("/api/tenants/t/conversations?view=mine&q=zeh");
  // Bekleyenlerde arama kutusu yoktur.
  expect(screen.queryByLabelText("Müşteri ara")).toBeNull();
});

it("konuşma yokken bunu söyler", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ conversations: [] })));
  render(<ConversationsPage store={store} />);
  await screen.findByText(/Henüz WhatsApp konuşması yok/);
});

it("daha eski sohbetler eklenir; çift tıklama satırları çoğaltmaz", async () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(`c${from + i}`, `Müşteri ${from + i}`, { updatedAt: new Date(Date.UTC(2026, 9, 3, 10, 0) - (from + i) * 60_000).toISOString() }));
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return json({ conversations: url.includes("before=") ? page(50, 7) : page(0, 50) });
  }));
  render(<ConversationsPage store={store} />);
  const more = await screen.findByRole("button", { name: "Daha eski sohbetler" });
  fireEvent.click(more);
  fireEvent.click(more);
  await screen.findByText("Müşteri 56");
  expect(screen.getAllByRole("link")).toHaveLength(57);
  expect(urls.filter((u) => u.includes("before="))).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Daha eski sohbetler" })).toBeNull();
});

const messages = [
  { id: "m1", sender: "customer", type: "text", text: "Ürün hasarlı geldi", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m2", sender: "customer", type: "image", text: null, createdAt: at, author: null, hasImage: true, sendError: null },
  { id: "m3", sender: "bot", type: "text", text: "Çok üzgünüm, hemen ilgileniyorum.", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m4", sender: "system", type: "team_answer", text: "Soru: Değişim olur mu?\nEkibin cevabı: Evet.", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m5", sender: "system", type: "note", text: "Zeynep konuşmayı devraldı", createdAt: at, author: null, hasImage: false, sendError: null },
  { id: "m6", sender: "agent", type: "text", text: "Merhaba, yeni ürünü yarın gönderiyoruz.", createdAt: at, author: { name: "Zeynep" }, hasImage: false, sendError: "{\"error\":{\"code\":131047}}" },
  { id: "m7", sender: "customer", type: "audio", text: null, createdAt: at, author: null, hasImage: false, sendError: null },
];

it("konuşma: mesajlar kimin yazdığıyla, iç notlar ayrı; devir, iletilenler ve Lina'nın açık sorusu yanda görünür", async () => {
  const posted: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") { posted.push({ url, body: JSON.parse(String(init.body)) }); return json({ ok: true }); }
    return json({
      conversation: { id: "c1", status: "waiting", assignedTo: null, canReply: false },
      customer: { name: "Zehra", phone: "+90 533 444 55 66" },
      messages,
      expertCalls: [{ agent: "returns", question: "[Hasarlı ürün] Ürün hasarlı geldi", answer: "EKİBE: iletildi", createdAt: at }],
      handoffs: [{ reason: "complaint", summary: "Müşteri öfkeli; hasarlı ürün.", status: "open", createdAt: at, resolvedAt: null }],
      notifications: [
        { id: "n1", label: "İade: ekip kararı gerekiyor", important: true, status: "open", orderNames: ["#MO-9010"], issues: ["Hasarlı ürün bildirildi."], updatedAt: "2026-10-03T12:05:00.000Z" },
        { id: "n2", label: "Sipariş sorusu", important: false, status: "open", orderNames: [], issues: [], updatedAt: null },
      ],
      teamQuestions: [{ id: "q1", question: "Hasarlı üründe kargo ücreti bizden mi?", createdAt: at }],
    });
  }));
  render(<ConversationPage store={store} conversationId="c1" userId="u1" />);
  await screen.findByText("Ürün hasarlı geldi");
  expect(screen.getByRole("heading", { name: "Zehra" })).toBeTruthy();
  expect(document.title).toBe("Zehra · Betül Saday · Lina Panel");
  expect(screen.getByRole("link", { name: "← Tüm sohbetler" }).getAttribute("href")).toBe("/m/s/sohbetler");
  expect(screen.getByAltText("Müşterinin gönderdiği fotoğraf").getAttribute("src")).toBe("/api/tenants/t/media/m2");
  expect(screen.getByText("Çok üzgünüm, hemen ilgileniyorum.").parentElement!.className).toBe("chat-bubble ours");
  expect(screen.getByText("Ürün hasarlı geldi").parentElement!.className).toBe("chat-bubble");
  expect(screen.getByText(/Ekibin Lina’ya cevabı \(müşteri görmez\)/)).toBeTruthy();
  expect(screen.getByText(/Zeynep konuşmayı devraldı/)).toBeTruthy();
  expect(screen.getByText(/^Ekip \(Zeynep\)/)).toBeTruthy();
  // WhatsApp'ın ham hata metni ekibe gösterilmez.
  expect(screen.getByText("Müşteriye gönderilemedi. Mesajı yeniden yazıp gönderin.")).toBeTruthy();
  expect(screen.queryByText(/131047/)).toBeNull();
  expect(screen.getByText("Ses mesajı")).toBeTruthy();
  expect(screen.getByText("Şikayet")).toBeTruthy();
  expect(screen.getByText("Müşteri öfkeli; hasarlı ürün.")).toBeTruthy();
  expect(screen.getByText("İade: ekip kararı gerekiyor")).toBeTruthy();
  expect(screen.queryByText("Sipariş sorusu")).toBeNull(); // sessiz kayıt ekibin işi değildir
  expect(screen.getByText(/^İade uzmanı/)).toBeTruthy();
  // Lina'nın ekibe sorduğu, cevabı beklenen soru konuşmada da görünür.
  expect(screen.getByText(/Hasarlı üründe kargo ücreti bizden mi\?/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Bekleyenler’de cevapla" }).getAttribute("href")).toBe("/m/s/bekleyenler");

  // İletilen talep konuşmanın içinden de tamamlanır; ekranda görülen hâlin zamanı gider.
  fireEvent.click(screen.getByRole("button", { name: "Tamamlandı: İade: ekip kararı gerekiyor" }));
  await vi.waitFor(() => expect(posted).toEqual([{ url: "/api/tenants/t/notifications/n1/done", body: { seenUpdatedAt: "2026-10-03T12:05:00.000Z" } }]));
});

/** Sahte sunucu: devral/geri ver/gönder isteklerini kaydeder ve konuşmanın durumunu ona göre değiştirir. */
function chatServer(start: { status: string; assignedTo: { id: string; name: string } | null; canReply?: boolean }, fail?: { path: string; status: number; error: string }) {
  let state = { canReply: false, ...start };
  const posted: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") {
      const path = url.split("/").at(-1)!;
      posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (fail?.path === path) return json({ error: fail.error }, fail.status);
      if (path === "takeover") state = { status: "human", assignedTo: { id: "u1", name: "Zeynep" }, canReply: true };
      if (path === "release") state = { status: "bot", assignedTo: null, canReply: false };
      return json({ ok: true });
    }
    return json({
      conversation: { id: "c1", ...state },
      customer: { name: "Zehra", phone: "+90 533 444 55 66" },
      messages: [{ id: "m1", sender: "customer", type: "text", text: "Yetkiliyle görüşmek istiyorum", createdAt: at, author: null, hasImage: false, sendError: null }],
      expertCalls: [], handoffs: [], notifications: [], teamQuestions: [],
    });
  }));
  return posted;
}

it("devral → yaz → Lina'ya geri ver", async () => {
  const posted = chatServer({ status: "waiting", assignedTo: null });
  render(<ConversationPage store={store} conversationId="c1" userId="u1" />);
  await screen.findByText("Yetkiliyle görüşmek istiyorum");
  // Devralmadan yazma kutusu yoktur.
  expect(screen.queryByLabelText("Müşteriye mesajınız")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Devral" }));
  const box = await screen.findByLabelText("Müşteriye mesajınız");
  expect(screen.queryByRole("button", { name: "Devral" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Ekipte: Zeynep");
  expect(screen.getByText(/Konuşma sizde: Lina bu müşteriye cevap vermiyor/)).toBeTruthy();

  fireEvent.change(box, { target: { value: " Merhaba Zehra Hanım " } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
  await vi.waitFor(() => expect((screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement).value).toBe(""));

  fireEvent.click(screen.getByRole("button", { name: "Lina’ya geri ver" }));
  await screen.findByRole("button", { name: "Devral" });
  expect(screen.queryByLabelText("Müşteriye mesajınız")).toBeNull();
  expect(posted).toEqual([
    { path: "takeover", body: undefined },
    { path: "messages", body: { text: "Merhaba Zehra Hanım" } },
    { path: "release", body: undefined },
  ]);
});

it("başkasının devraldığı konuşmada çalışan devralamaz ve geri veremez; mağaza sahibi yapabilir", async () => {
  chatServer({ status: "human", assignedTo: { id: "u2", name: "Ali" } });
  const { unmount } = render(<ConversationPage store={store} conversationId="c1" userId="u1" />);
  await screen.findByText(/Yalnızca devralan kişi yazabilir/);
  expect(screen.queryByRole("button", { name: "Devral" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Lina’ya geri ver" })).toBeNull();
  expect(screen.queryByLabelText("Müşteriye mesajınız")).toBeNull();
  unmount();

  render(<ConversationPage store={{ ...store, role: "owner" }} conversationId="c1" userId="u1" />);
  await screen.findByRole("button", { name: "Devral" });
  expect(screen.getByRole("button", { name: "Lina’ya geri ver" })).toBeTruthy();
});

it("devralan kişi silinmişse (konuşma kimsede değil) çalışan da devralabilir ya da geri verebilir", async () => {
  chatServer({ status: "human", assignedTo: null });
  render(<ConversationPage store={store} conversationId="c1" userId="u1" />);
  await screen.findByRole("button", { name: "Devral" });
  expect(screen.getByRole("button", { name: "Lina’ya geri ver" })).toBeTruthy();
});

it("24 saat geçtiyse yazma kutusu kapanır ve nedeni yazar; gönderilemeyen mesajda taslak silinmez", async () => {
  chatServer({ status: "human", assignedTo: { id: "u1", name: "Zeynep" }, canReply: false });
  const { unmount } = render(<ConversationPage store={store} conversationId="c1" userId="u1" />);
  await screen.findByText(/Müşterinin son mesajından 24 saat geçti/);
  expect(screen.queryByLabelText("Müşteriye mesajınız")).toBeNull();
  expect(screen.getByRole("button", { name: "Lina’ya geri ver" })).toBeTruthy();
  unmount();

  chatServer({ status: "human", assignedTo: { id: "u1", name: "Zeynep" }, canReply: true }, { path: "messages", status: 502, error: "Mesaj WhatsApp'a gönderilemedi. Lütfen tekrar deneyin." });
  render(<ConversationPage store={store} conversationId="c1" userId="u1" />);
  fireEvent.change(await screen.findByLabelText("Müşteriye mesajınız"), { target: { value: "Merhaba" } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
  await screen.findByText("Mesaj WhatsApp'a gönderilemedi. Lütfen tekrar deneyin.");
  expect((screen.getByLabelText("Müşteriye mesajınız") as HTMLTextAreaElement).value).toBe("Merhaba");
});

it("Bekleyenler'den açılan konuşma Bekleyenler'e geri döner", async () => {
  history.replaceState(null, "", "/m/s/sohbetler/c1?from=bekleyenler");
  chatServer({ status: "waiting", assignedTo: null });
  render(<ConversationPage store={store} conversationId="c1" userId="u1" />);
  await screen.findByText("Yetkiliyle görüşmek istiyorum");
  expect(screen.getByRole("link", { name: "← Bekleyenler" }).getAttribute("href")).toBe("/m/s/bekleyenler");
});
