// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WaitingPage } from "./WaitingPage";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const question = {
  id: "q1", conversationId: "c1", customer: { name: "Ayşe", phone: "+90 500 111 22 33" },
  question: "Hediye paketi yapıyor musunuz?", context: "Doğum günü hediyesi", customerMessage: "hediye paketi var mı",
  status: "open", answer: null, answeredBy: null, answeredAt: null, createdAt: new Date().toISOString(),
};
const forwarded = {
  id: "n1", conversationId: "c2", customer: { name: "Elif", phone: "+90 532 999 88 77" }, label: "İade: ekip kararı gerekiyor", orderNames: ["#MO-9013"],
  question: "İadem 50 gündür yatmadı", answer: "İade birimine ilettim.", issues: ["Para iadesi 50 gündür yapılmadı."], createdAt: new Date().toISOString(),
  updatedAt: "2026-10-03T12:05:00.000Z", doneAt: null, doneBy: null,
};
const handedOff = {
  id: "c9", status: "waiting", updatedAt: new Date().toISOString(), customer: { name: "Zehra", phone: "+90 533 444 55 66" }, assignedTo: null,
  openHandoff: { reason: "customer_request", summary: "Müşteri temsilciyle görüşmek istiyor; kargo gecikmesinden şikayetçi.", createdAt: new Date().toISOString() },
  lastMessage: null,
};

/** Sahte sunucu: cevaplanan soru ve tamamlanan talep listeden düşer, geri alınan talep geri gelir. */
function server(role: "owner" | "agent", fail: { path?: string; done?: number } = {}) {
  const posted: { url: string; body: unknown }[] = [];
  let questions = [question];
  let open = [forwarded];
  let done: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (fail.path && url.includes(fail.path)) return json({ error: "Sunucu hatası" }, 500);
    if (init.method === "POST") {
      posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/done")) {
        if (fail.done) return json({ error: "Bu talep siz bakarken güncellendi: müşteri yeni bir şey yazdı. Yeni hâline bakıp tekrar deneyin." }, fail.done);
        open = [];
        done = [{ ...forwarded, doneAt: new Date().toISOString(), doneBy: { name: "Zeynep" } }];
      }
      if (url.endsWith("/reopen")) { open = [forwarded]; done = []; }
      if (url.endsWith("/answer")) questions = [];
      return json({ ok: true, taught: true, windowClosed: false });
    }
    if (url.includes("/conversations")) return json({ conversations: [handedOff] });
    if (url.includes("/notifications")) return json({ notifications: url.includes("status=done") ? done : open });
    return json({ questions: url.includes("answered") ? [] : questions });
  }));
  render(<WaitingPage store={{ tenantId: "t", slug: "s", name: "Betül Saday", role }} />);
  return posted;
}

it("Lina'nın sorusu listelenir; cevap gönderilince listeden düşer ve Lina'nın ileteceği söylenir", async () => {
  const posted = server("owner");
  await screen.findByText("Hediye paketi yapıyor musunuz?");
  fireEvent.change(screen.getByLabelText("Cevabınız"), { target: { value: "Evet, ücretsiz." } });
  fireEvent.click(screen.getByLabelText(/Lina’ya öğret/));
  fireEvent.click(screen.getByRole("button", { name: "Cevabı gönder" }));
  await screen.findByText(/Lina cevabınızı müşteriye iletiyor/);
  expect(posted).toEqual([{ url: "/api/tenants/t/team-questions/q1/answer", body: { answer: "Evet, ücretsiz.", teach: true } }]);
  await vi.waitFor(() => expect(screen.queryByText("Hediye paketi yapıyor musunuz?")).toBeNull());
});

it("çalışan cevaplar ama 'Lina'ya öğret' seçeneğini görmez", async () => {
  server("agent");
  await screen.findByText("Hediye paketi yapıyor musunuz?");
  expect(screen.queryByLabelText(/Lina’ya öğret/)).toBeNull();
});

it("her kart konuşmaya bağlantı verir (Bekleyenler'e geri dönülecek şekilde)", async () => {
  server("agent");
  await screen.findByText("Hediye paketi yapıyor musunuz?");
  await screen.findByText("Temsilci istedi");
  const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
  expect(href("Ayşe ile konuşmayı aç")).toBe("/m/s/sohbetler/c1?from=bekleyenler");
  expect(href("Elif ile konuşmayı aç")).toBe("/m/s/sohbetler/c2?from=bekleyenler");
  expect(href("Zehra ile konuşmayı aç")).toBe("/m/s/sohbetler/c9?from=bekleyenler");
});

it("ekibe iletilen talep listelenir; 'Tamamlandı' denince listeden düşer, yanlış basıldıysa geri alınır", async () => {
  const posted = server("agent");
  await screen.findByText("İade: ekip kararı gerekiyor (#MO-9013)");
  expect(screen.getByText(/müşteri .* yeniden yazdı$/)).toBeTruthy();
  expect(screen.getByText("Para iadesi 50 gündür yapılmadı.")).toBeTruthy();
  expect(screen.getByText("İade birimine ilettim.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Tamamlandı: Elif/ }));
  const notice = await screen.findByText(/Elif: talep tamamlandı\./);
  // Ekranda görülen hâlin zamanı gider: müşteri bu arada yeniden yazdıysa sunucu kapatmaz.
  expect(posted).toEqual([{ url: "/api/tenants/t/notifications/n1/done", body: { seenUpdatedAt: "2026-10-03T12:05:00.000Z" } }]);
  await vi.waitFor(() => expect(screen.queryByText("İade: ekip kararı gerekiyor (#MO-9013)")).toBeNull());
  expect(screen.getByText("Şu an ekibe iletilen talep yok.")).toBeTruthy();

  fireEvent.click(within(notice).getByRole("button", { name: "Geri al" }));
  await screen.findByText("Elif: talep yeniden açıldı.");
  expect(posted[1]!.url).toBe("/api/tenants/t/notifications/n1/reopen");
  await screen.findByText("İade: ekip kararı gerekiyor (#MO-9013)");
});

it("tamamlananlar kimin tamamladığıyla listelenir ve oradan da geri alınabilir", async () => {
  const posted = server("agent");
  fireEvent.click(await screen.findByRole("button", { name: /^Tamamlandı: Elif/ }));
  await screen.findByText(/Elif: talep tamamlandı\./);
  fireEvent.click(screen.getByRole("button", { name: "Tamamlananları göster" }));
  await screen.findByText(/tamamlandı · Zeynep/);
  fireEvent.click(screen.getByRole("button", { name: /^Geri al: Elif/ }));
  await screen.findByText("Elif: talep yeniden açıldı.");
  expect(posted.map((p) => p.url.split("/").at(-1))).toEqual(["done", "reopen"]);
});

it("müşteri bu arada yeniden yazdıysa 'Tamamlandı' kapatmaz: nedeni yazar, kart kalır", async () => {
  server("agent", { done: 409 });
  fireEvent.click(await screen.findByRole("button", { name: /^Tamamlandı: Elif/ }));
  await screen.findByText(/siz bakarken güncellendi/);
  expect(screen.getByText("İade: ekip kararı gerekiyor (#MO-9013)")).toBeTruthy();
});

it("devredilen konuşma sebebi ve özetiyle listelenir", async () => {
  server("agent");
  await screen.findByText("Temsilci istedi");
  expect(screen.getByText("Müşteri temsilciyle görüşmek istiyor; kargo gecikmesinden şikayetçi.")).toBeTruthy();
});

it("ekipteyken müşteri yeniden yazdıysa konuşma 'cevap bekliyor' diye listelenir", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/conversations")) return json({ conversations: [{
      ...handedOff, id: "c7", status: "human", assignedTo: { id: "u2", name: "Ali" }, openHandoff: null,
      customer: { name: "Merve", phone: "+90 531 000 00 03" },
      lastMessage: { sender: "customer", type: "text", text: "Hâlâ cevap yok", createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
    }] });
    if (url.includes("/notifications")) return json({ notifications: [] });
    return json({ questions: [] });
  }));
  render(<WaitingPage store={{ tenantId: "t", slug: "s", name: "Betül Saday", role: "agent" }} />);
  await screen.findByText("Müşteri 3 sa önce yazdı, cevap bekliyor.");
  expect(screen.getByText(/Ekipte: Ali/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Merve ile konuşmayı aç" })).toBeTruthy();
});

it("bir bölüm yüklenemezse diğerleri yine görünür", async () => {
  server("agent", { path: "/notifications" });
  await screen.findByText("Hediye paketi yapıyor musunuz?");
  await screen.findByText("Temsilci istedi");
  expect(screen.getByRole("alert").textContent).toBe("Sunucu hatası");
});

it("adı olmayan müşteride telefon iki kez yazılmaz", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/conversations")) return json({ conversations: [] });
    if (url.includes("/notifications")) return json({ notifications: [{ ...forwarded, customer: { name: "+90 532 999 88 77", phone: "+90 532 999 88 77" } }] });
    return json({ questions: [] });
  }));
  render(<WaitingPage store={{ tenantId: "t", slug: "s", name: "Betül Saday", role: "agent" }} />);
  await screen.findByText("İade: ekip kararı gerekiyor (#MO-9013)");
  expect(screen.getAllByText("+90 532 999 88 77")).toHaveLength(1);
});
