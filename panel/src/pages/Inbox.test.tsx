// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./Inbox";
import { buildQueue, initials, waitLabel, type ConversationRow, type Forwarded, type Question } from "./inbox-shared";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const store = (role: "owner" | "agent" = "agent") => ({ tenantId: "t", slug: "s", name: "Betül Saday", role });

const question = (over: Partial<Question> = {}): Question => ({
  id: "q1", conversationId: "c1", customer: { name: "Ayşe", phone: "+90 532 000 00 01" },
  question: "Hediye paketi yapıyor musunuz?", context: "Doğum günü hediyesi", customerMessage: "hediye paketi var mı",
  status: "open", answer: null, answeredBy: null, answeredAt: null, createdAt: minutesAgo(25), ...over,
});
const forwarded = (over: Partial<Forwarded> = {}): Forwarded => ({
  id: "n1", conversationId: "c2", customer: { name: "Elif", phone: "+90 532 999 88 77" }, kind: "return_review",
  label: "İade: ekip kararı gerekiyor", orderNames: ["#MO-9013"], question: "İadem 50 gündür yatmadı", answer: "İade birimine ilettim.",
  issues: ["Para iadesi 50 gündür yapılmadı."], createdAt: minutesAgo(90), updatedAt: null, doneAt: null, doneBy: null, ...over,
});
const row = (id: string, name: string, over: Partial<ConversationRow> = {}): ConversationRow => ({
  id, status: "bot", updatedAt: minutesAgo(30), customer: { name, phone: "+90 532 000 00 00" }, assignedTo: null, openHandoff: null,
  lastMessage: { sender: "bot", type: "text", text: "Kargonuz yolda.", createdAt: minutesAgo(30) }, ...over,
});
const handedOff = (over: Partial<ConversationRow> = {}): ConversationRow => row("c9", "Zehra", {
  status: "waiting",
  openHandoff: { reason: "customer_request", summary: "Müşteri temsilciyle görüşmek istiyor; kargo gecikmesinden şikayetçi.", createdAt: minutesAgo(10) },
  lastMessage: { sender: "customer", type: "text", text: "Yetkiliyle görüşmek istiyorum", createdAt: minutesAgo(10) }, ...over,
});

describe("buildQueue", () => {
  it("aynı müşterinin sorusu, talebi ve devri tek satırdır; en uzun bekleyen üstte", () => {
    const items = buildQueue({
      questions: [question({ conversationId: "c2", createdAt: minutesAgo(30) })],
      forwarded: [forwarded({ conversationId: "c2", createdAt: minutesAgo(90) })],
      handedOff: [handedOff({ id: "c2", customer: { name: "Elif", phone: "x" } }), handedOff({ id: "c3", customer: { name: "Merve", phone: "y" }, openHandoff: { reason: "other", summary: "Başka", createdAt: minutesAgo(5) } })],
    });
    expect(items.map((i) => i.id)).toEqual(["c2", "c3"]);
    const elif = items[0]!;
    expect(elif.chips.map((c) => c.label)).toEqual(["Temsilci istedi", "İade: ekip kararı gerekiyor", "Lina soruyor"]);
    // En eski kaynağın zamanı (talep, 90 dk önce) bekleme süresini belirler.
    expect(waitLabel(elif.since)).toBe("1 sa");
    // Özet önceliği: devir özeti > talep > Lina'nın sorusu.
    expect(elif.summary).toBe("Müşteri temsilciyle görüşmek istiyor; kargo gecikmesinden şikayetçi.");
  });

  it("devir yoksa özet talepten, o da yoksa Lina'nın sorusundan gelir; renkler ciddiyete göre", () => {
    const [a, b] = buildQueue({
      questions: [question({ conversationId: "c5", createdAt: minutesAgo(50) })],
      forwarded: [forwarded({ conversationId: "c6", kind: "complaint", label: "Şikayet", createdAt: minutesAgo(40) })],
      handedOff: [],
    });
    expect(a).toMatchObject({ id: "c5", summary: "Hediye paketi yapıyor musunuz?", chips: [{ label: "Lina soruyor", tone: "blue" }] });
    expect(b).toMatchObject({ id: "c6", summary: "Para iadesi 50 gündür yapılmadı.", chips: [{ label: "Şikayet", tone: "red" }] });
  });

  it("ekipteyken müşteri yazdıysa 'Cevap bekliyor' ve ekipteki kişi görünür", () => {
    const [item] = buildQueue({
      questions: [], forwarded: [],
      handedOff: [row("c7", "Merve", { status: "human", assignedTo: { id: "u2", name: "Ali" }, lastMessage: { sender: "customer", type: "text", text: "Hâlâ cevap yok", createdAt: minutesAgo(180) } })],
    });
    expect(item!.chips).toEqual([{ label: "Cevap bekliyor", tone: "red" }, { label: "Ekipte: Ali", tone: "green" }]);
    expect(waitLabel(item!.since)).toBe("3 sa");
    expect(item!.summary).toBe("Müşteri: Hâlâ cevap yok");
  });
});

it("yardımcılar: bekleme süresi ve baş harfler", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const at = (m: number) => new Date(now - m * 60_000).toISOString();
  expect([0, 5, 59, 60, 180, 1440, 3000].map((m) => waitLabel(at(m), now))).toEqual(["az önce", "5 dk", "59 dk", "1 sa", "3 sa", "1 gün", "2 gün"]);
  expect(initials("Zehra Demir")).toBe("ZD");
  expect(initials("ayşe")).toBe("A");
  expect(initials("+90 532 000 00 00")).toBe("?");
});

/** Sahte sunucu: üç bekleyen kaynağı, "bende" ve "tümü" listelerini ve geri alma isteğini karşılar. */
function server(o: { questions?: Question[]; forwarded?: Forwarded[]; waiting?: ConversationRow[]; mine?: ConversationRow[]; all?: ConversationRow[]; done?: Forwarded[]; fail?: string } = {}) {
  const urls: string[] = [];
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") { posted.push(url); return json({ ok: true }); }
    urls.push(url);
    if (o.fail && url.includes(o.fail)) return json({ error: "Sunucu hatası" }, 500);
    if (url.includes("/team-questions")) return json({ questions: url.includes("answered") ? [] : (o.questions ?? []) });
    if (url.includes("/notifications")) return json({ notifications: url.includes("status=done") ? (o.done ?? []) : (o.forwarded ?? []) });
    if (url.includes("view=waiting")) return json({ conversations: o.waiting ?? [] });
    if (url.includes("view=mine")) return json({ conversations: o.mine ?? [] });
    return json({ conversations: url.includes("q=") ? [] : (o.all ?? []) });
  }));
  return { urls, posted };
}
const open = (props: Partial<React.ComponentProps<typeof InboxPage>> = {}) =>
  render(<InboxPage store={store()} userId="u1" section="bekleyenler" {...props} />);

it("bekleyenler: müşteri başına bir satır; etiketler, bekleme süresi ve bağlantılar", async () => {
  server({ questions: [question()], forwarded: [forwarded()], waiting: [handedOff()] });
  open();
  await screen.findByText("Hediye paketi yapıyor musunuz?");
  expect(screen.getByRole("heading", { name: "Bekleyenler" })).toBeTruthy();
  // Üç müşteri, en uzun bekleyen (Elif, 90 dk) üstte.
  const links = screen.getAllByRole("link");
  expect(links.map((l) => l.getAttribute("href"))).toEqual(["/m/s/bekleyenler/c2", "/m/s/bekleyenler/c1", "/m/s/bekleyenler/c9"]);
  const elif = links[0]!;
  expect(within(elif).getByText("İade: ekip kararı gerekiyor")).toBeTruthy();
  expect(within(elif).getByText("1 sa")).toBeTruthy();
  expect(elif.getAttribute("aria-label")).toBe("Elif, +90 532 999 88 77, İade: ekip kararı gerekiyor, 1 sa bekliyor");
  // 20 dakikayı geçen bekleme vurgulanır; 10 dakikalık vurgulanmaz.
  expect(within(links[1]!).getByText("25 dk").className).toContain("late");
  expect(within(links[2]!).getByText("10 dk").className).not.toContain("late");
  expect(within(links[1]!).getByText("Lina soruyor")).toBeTruthy();
  expect(within(links[2]!).getByText("Temsilci istedi")).toBeTruthy();
  // Sekme sayıları.
  expect(screen.getByRole("tab", { name: /Bekleyen\s*3/ }).getAttribute("aria-selected")).toBe("true");
  // Konuşma seçilmediyse sağ bölme yol gösterir.
  expect(screen.getByText("Soldan bir konuşma seçin.")).toBeTruthy();
});

it("seçili konuşma işaretlenir ve sağ bölmede açılır", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (/conversations\/c2$/.test(url)) {
      return json({
        conversation: { id: "c2", status: "waiting", assignedTo: null, canReply: false, windowOpenUntil: null },
        customer: { name: "Elif", phone: "+90 532 999 88 77" },
        messages: [{ id: "m1", sender: "customer", type: "text", text: "İadem 50 gündür yatmadı", createdAt: minutesAgo(90), author: null, hasImage: false, sendError: null }],
        expertCalls: [], handoffs: [], notifications: [], teamQuestions: [],
      });
    }
    if (url.includes("/notifications")) return json({ notifications: [forwarded()] });
    if (url.includes("/team-questions")) return json({ questions: [] });
    return json({ conversations: [] });
  }));
  open({ conversationId: "c2" });
  await screen.findByRole("heading", { name: "Elif", level: 2 });
  expect(screen.getByRole("link", { name: /^Elif, / }).getAttribute("aria-current")).toBe("true");
  expect(screen.queryByText("Soldan bir konuşma seçin.")).toBeNull();
  expect(screen.getAllByText("İadem 50 gündür yatmadı").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Listeye dön" }).getAttribute("href")).toBe("/m/s/bekleyenler");
});

it("bekleyen yoksa bunu söyler; bir kaynak yüklenemezse diğerleri yine görünür", async () => {
  server({});
  const { unmount } = open();
  await screen.findByText(/Şu an ekibi bekleyen iş yok/);
  unmount();

  server({ questions: [question()], fail: "/notifications" });
  open();
  await screen.findByText("Hediye paketi yapıyor musunuz?");
  expect((await screen.findByRole("alert")).textContent).toBe("Sunucu hatası");
});

it("adı olmayan müşteride telefon iki kez yazılmaz", async () => {
  server({ forwarded: [forwarded({ customer: { name: "+90 532 999 88 77", phone: "+90 532 999 88 77" } })] });
  open();
  await screen.findByText("İade: ekip kararı gerekiyor");
  expect(screen.getAllByText("+90 532 999 88 77")).toHaveLength(1);
});

it("tamamlananlar kimin tamamladığıyla listelenir ve oradan geri alınabilir", async () => {
  const done = forwarded({ doneAt: minutesAgo(5), doneBy: { name: "Zeynep" } });
  const { posted } = server({ done: [done] });
  open();
  await screen.findByText(/Şu an ekibi bekleyen iş yok/);
  fireEvent.click(screen.getByRole("button", { name: "Tamamlananları göster" }));
  await screen.findByText(/5 dk önce tamamlandı · Zeynep/);
  fireEvent.click(screen.getByRole("button", { name: /^Geri al: Elif/ }));
  await vi.waitFor(() => expect(posted).toEqual(["/api/tenants/t/notifications/n1/reopen"]));
});

it("bende: devraldığım konuşmalar; tümü: arama sunucuya gider, bekleyenlerde arama kutusu yoktur", async () => {
  const { urls } = server({ mine: [row("c2", "Elif", { status: "human", assignedTo: { id: "u1", name: "Zeynep" } })], all: [row("c3", "Ayşe")] });
  open();
  await screen.findByText(/Şu an ekibi bekleyen iş yok/);
  expect(screen.queryByLabelText("Müşteri ara")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /Bende/ }));
  await screen.findByText("Elif");
  expect(screen.getByText("Ekipte: Zeynep")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Tümü" }));
  await screen.findByText("Ayşe");
  fireEvent.change(screen.getByLabelText("Müşteri ara"), { target: { value: " zeh " } });
  await screen.findByText("Bu aramayla eşleşen konuşma yok.");
  expect(urls).toContain("/api/tenants/t/conversations?view=all&q=zeh");
});

it("tüm sohbetler: tümü sekmesiyle açılır; müşteri, durum ve son mesajla listelenir", async () => {
  const lastMessage = (sender: string, type: string, text: string | null) => ({ sender, type, text, createdAt: minutesAgo(30) });
  server({ all: [
    row("c1", "Zehra", { status: "waiting", lastMessage: lastMessage("customer", "text", "Temsilciyle görüşmek istiyorum") }),
    row("c2", "Elif", { status: "human", assignedTo: { id: "u1", name: "Zeynep" }, lastMessage: lastMessage("customer", "image", null) }),
    row("c3", "Ayşe"),
    row("c4", "+90 532 000 00 00", { lastMessage: lastMessage("system", "team_answer", "Soru: …\nEkibin cevabı: …") }),
  ] });
  open({ section: "sohbetler" });
  await screen.findByText("Müşteri: Temsilciyle görüşmek istiyorum");
  expect(screen.getByRole("heading", { name: "Tüm sohbetler" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Tümü" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("Ekibi bekliyor")).toBeTruthy();
  expect(screen.getByText("Müşteri: Fotoğraf")).toBeTruthy();
  expect(screen.getByText("Lina: Kargonuz yolda.")).toBeTruthy();
  // Ekibin Lina'ya iç cevabı müşteriye giden mesaj gibi görünmez.
  expect(screen.getByText("Ekip Lina’nın sorusunu cevapladı")).toBeTruthy();
  expect(screen.getAllByRole("link")[0]!.getAttribute("href")).toBe("/m/s/sohbetler/c1");
  expect(screen.queryByRole("button", { name: "Daha eski sohbetler" })).toBeNull();
});

it("daha eski sohbetler eklenir; çift tıklama satırları çoğaltmaz", async () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(`c${from + i}`, `Müşteri ${from + i}`, { updatedAt: new Date(Date.UTC(2026, 9, 3, 10, 0) - (from + i) * 60_000).toISOString() }));
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.includes("/notifications")) return json({ notifications: [] });
    if (url.includes("/team-questions")) return json({ questions: [] });
    if (url.includes("view=waiting") || url.includes("view=mine")) return json({ conversations: [] });
    return json({ conversations: url.includes("before=") ? page(50, 7) : page(0, 50) });
  }));
  open({ section: "sohbetler" });
  const more = await screen.findByRole("button", { name: "Daha eski sohbetler" });
  fireEvent.click(more);
  fireEvent.click(more);
  await screen.findByText("Müşteri 56");
  expect(screen.getAllByRole("link")).toHaveLength(57);
  expect(urls.filter((u) => u.includes("before="))).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Daha eski sohbetler" })).toBeNull();
});

it("konuşma yokken bunu söyler", async () => {
  server({});
  open({ section: "sohbetler" });
  await screen.findByText(/Henüz WhatsApp konuşması yok/);
});
