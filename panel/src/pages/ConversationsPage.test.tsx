// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationPage, ConversationsPage } from "./ConversationsPage";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "agent" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const at = "2026-10-03T10:00:00Z";

it("tüm sohbetler: müşteri, durum ve son mesajla listelenir; satır konuşmayı açar", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return json({ conversations: [
      { id: "c1", status: "waiting", updatedAt: at, customer: { name: "Zehra", phone: "+90 533 444 55 66" }, assignedTo: null, openHandoff: null, lastMessage: { sender: "customer", type: "text", text: "Temsilciyle görüşmek istiyorum", createdAt: at } },
      { id: "c2", status: "human", updatedAt: at, customer: { name: "Elif", phone: "+90 532 999 88 77" }, assignedTo: { id: "u1", name: "Zeynep" }, openHandoff: null, lastMessage: { sender: "customer", type: "image", text: null, createdAt: at } },
      { id: "c3", status: "bot", updatedAt: at, customer: { name: "Ayşe", phone: "+90 532 123 45 67" }, assignedTo: null, openHandoff: null, lastMessage: { sender: "bot", type: "text", text: "Kargonuz yolda.", createdAt: at } },
    ] });
  }));
  render(<ConversationsPage store={store} />);
  await screen.findByText("Müşteri: Temsilciyle görüşmek istiyorum");
  expect(urls).toEqual(["/api/tenants/t/conversations?view=all"]);
  expect(screen.getByText("Ekibi bekliyor")).toBeTruthy();
  expect(screen.getByText("Ekipte: Zeynep")).toBeTruthy();
  expect(screen.getByText("Müşteri: Fotoğraf")).toBeTruthy();
  expect(screen.getByText("Lina: Kargonuz yolda.")).toBeTruthy();
  expect(screen.getByText("Lina cevaplıyor")).toBeTruthy();
  expect(screen.getAllByRole("link")[0]!.getAttribute("href")).toBe("/m/s/sohbetler/c1");
  // 50'den az konuşma geldiyse daha eskisi yoktur.
  expect(screen.queryByRole("button", { name: "Daha eski sohbetler" })).toBeNull();
});

it("konuşma yokken bunu söyler", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ conversations: [] })));
  render(<ConversationsPage store={store} />);
  await screen.findByText(/Henüz WhatsApp konuşması yok/);
});

it("konuşma: mesajlar kimin yazdığıyla, iç notlar ayrı, devir ve iletilenler yanda görünür", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({
    conversation: { id: "c1", status: "waiting", assignedTo: null },
    customer: { name: "Zehra", phone: "+90 533 444 55 66" },
    messages: [
      { id: "m1", sender: "customer", type: "text", text: "Ürün hasarlı geldi", createdAt: at, author: null, hasImage: false, sendError: null },
      { id: "m2", sender: "customer", type: "image", text: null, createdAt: at, author: null, hasImage: true, sendError: null },
      { id: "m3", sender: "bot", type: "text", text: "Çok üzgünüm, hemen ilgileniyorum.", createdAt: at, author: null, hasImage: false, sendError: null },
      { id: "m4", sender: "system", type: "team_answer", text: "Soru: Değişim olur mu?\nEkibin cevabı: Evet.", createdAt: at, author: null, hasImage: false, sendError: null },
      { id: "m5", sender: "system", type: "note", text: "Zeynep konuşmayı devraldı", createdAt: at, author: null, hasImage: false, sendError: null },
      { id: "m6", sender: "agent", type: "text", text: "Merhaba, yeni ürünü yarın gönderiyoruz.", createdAt: at, author: { name: "Zeynep" }, hasImage: false, sendError: "pencere kapalı" },
      { id: "m7", sender: "customer", type: "audio", text: null, createdAt: at, author: null, hasImage: false, sendError: null },
    ],
    expertCalls: [{ agent: "returns", question: "[Hasarlı ürün] Ürün hasarlı geldi", answer: "EKİBE: iletildi", createdAt: at }],
    handoffs: [{ reason: "complaint", summary: "Müşteri öfkeli; hasarlı ürün.", status: "open", createdAt: at, resolvedAt: null }],
    notifications: [
      { id: "n1", label: "İade: ekip kararı gerekiyor", important: true, status: "open", orderNames: ["#MO-9010"], issues: ["Hasarlı ürün bildirildi."] },
      { id: "n2", label: "Sipariş sorusu", important: false, status: "open", orderNames: [], issues: [] },
    ],
  })));
  render(<ConversationPage store={store} conversationId="c1" />);
  await screen.findByText("Ürün hasarlı geldi");
  expect(screen.getByRole("heading", { name: "Zehra" })).toBeTruthy();
  expect(screen.getByAltText("Müşterinin gönderdiği fotoğraf").getAttribute("src")).toBe("/api/tenants/t/media/m2");
  expect(screen.getByText("Çok üzgünüm, hemen ilgileniyorum.").parentElement!.className).toBe("chat-bubble ours");
  expect(screen.getByText("Ürün hasarlı geldi").parentElement!.className).toBe("chat-bubble");
  expect(screen.getByText(/Ekibin Lina’ya cevabı \(müşteri görmez\)/)).toBeTruthy();
  expect(screen.getByText(/Zeynep konuşmayı devraldı/)).toBeTruthy();
  expect(screen.getByText(/^Ekip \(Zeynep\)/)).toBeTruthy();
  expect(screen.getByText("Müşteriye gönderilemedi: pencere kapalı")).toBeTruthy();
  expect(screen.getByText("Ses mesajı")).toBeTruthy();
  expect(screen.getByText("Şikayet")).toBeTruthy();
  expect(screen.getByText("Müşteri öfkeli; hasarlı ürün.")).toBeTruthy();
  expect(screen.getByText("İade: ekip kararı gerekiyor")).toBeTruthy();
  expect(screen.queryByText("Sipariş sorusu")).toBeNull(); // sessiz kayıt ekibin işi değildir
  expect(screen.getByText(/^İade uzmanı/)).toBeTruthy();
});
