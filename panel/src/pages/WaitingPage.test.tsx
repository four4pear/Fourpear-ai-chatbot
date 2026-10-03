// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  id: "n1", customer: { name: "Elif", phone: "+90 532 999 88 77" }, label: "İade: ekip kararı gerekiyor", orderNames: ["#MO-9013"],
  question: "İadem 50 gündür yatmadı", answer: "İade birimine ilettim.", issues: ["Para iadesi 50 gündür yapılmadı."], createdAt: new Date().toISOString(),
};

function server(role: "owner" | "agent") {
  const posted: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes("/notifications")) {
      if (init.method === "POST") { posted.push(url); return json({ ok: true }); }
      return json({ notifications: [forwarded] });
    }
    if (init.method === "POST") { posted.push(JSON.parse(String(init.body))); return json({ ok: true, taught: true, windowClosed: false }); }
    return json({ questions: url.includes("answered") ? [] : [question] });
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
  expect(posted).toEqual([{ answer: "Evet, ücretsiz.", teach: true }]);
  expect(screen.queryByText("Hediye paketi yapıyor musunuz?")).toBeNull();
});

it("çalışan cevaplar ama 'Lina'ya öğret' seçeneğini görmez", async () => {
  server("agent");
  await screen.findByText("Hediye paketi yapıyor musunuz?");
  expect(screen.queryByLabelText(/Lina’ya öğret/)).toBeNull();
});

it("ekibe iletilen talep listelenir; 'Tamamlandı' denince listeden düşer", async () => {
  const posted = server("agent");
  await screen.findByText("İade: ekip kararı gerekiyor (#MO-9013)");
  expect(screen.getByText("Para iadesi 50 gündür yapılmadı.")).toBeTruthy();
  expect(screen.getByText("İade birimine ilettim.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Tamamlandı" }));
  await screen.findByText("Elif: talep tamamlandı olarak işaretlendi.");
  expect(posted).toEqual(["/api/tenants/t/notifications/n1/done"]);
  expect(screen.queryByText("İade: ekip kararı gerekiyor (#MO-9013)")).toBeNull();
  expect(screen.getByText("Şu an ekibe iletilen talep yok.")).toBeTruthy();
});
