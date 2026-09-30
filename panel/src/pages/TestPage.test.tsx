// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TestPage } from "./TestPage";
const store = { tenantId: "t", slug: "test", name: "Test", role: "owner" as const };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (text: string) => new Response(JSON.stringify({ replies: [text], runs: [], handoffs: [], demoHelp: [] }));
const write = (text: string) => {
  fireEvent.change(screen.getByLabelText("Mesajınız"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
};
const sentHistory = (fetch: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse(String((fetch.mock.calls[call]![1] as RequestInit).body)).history;

it("shows a reply and resets the test conversation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply("Kargo iki gün.")));
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Kargo?");
  await screen.findByText("Kargo iki gün.");
  fireEvent.click(screen.getByRole("button", { name: "Yeni sohbet" }));
  expect(screen.queryByText("Kargo iki gün.")).toBeNull();
});

it("keeps the draft after an API error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Tekrar deneyin" }), { status: 503 })));
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Merhaba");
  await screen.findByRole("alert");
  await waitFor(() => expect((screen.getByLabelText("Mesajınız") as HTMLTextAreaElement).value).toBe("Merhaba"));
});

it("answers consecutive messages once, after the customer stops writing", async () => {
  const fetch = vi.fn(async () => reply("Siparişinize bakıyorum."));
  vi.stubGlobal("fetch", fetch);
  render(<TestPage store={store} replyDelayMs={80} />);
  write("Merhaba");
  expect(screen.getByRole("status").textContent).toContain("Lina bekliyor");
  write("siparişim gelmedi");
  write("#1045");
  await screen.findByText("Siparişinize bakıyorum.");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sentHistory(fetch, 0)).toEqual([
    { role: "user", text: "Merhaba" },
    { role: "user", text: "siparişim gelmedi" },
    { role: "user", text: "#1045" },
  ]);
});

it("cancels the reply being prepared when a new message arrives", async () => {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    if (signals.length > 1) return Promise.resolve(reply("İkisine birden cevap."));
    return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  });
  vi.stubGlobal("fetch", fetch);
  render(<TestPage store={store} replyDelayMs={0} />);
  write("Merhaba");
  await screen.findByText(/cevap hazırlıyor/);
  write("iade nasıl yapılır?");
  await screen.findByText("İkisine birden cevap.");
  expect(signals[0]!.aborted).toBe(true);
  expect(sentHistory(fetch, 1)).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
