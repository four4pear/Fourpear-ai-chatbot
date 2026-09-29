// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TestPage } from "./TestPage";
const store = { tenantId: "t", slug: "test", name: "Test", role: "owner" as const };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows a reply and resets the test conversation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ replies: ["Kargo iki gün."], runs: [], handoffs: [], demoHelp: [] }))));
  render(<TestPage store={store} />);
  fireEvent.change(screen.getByLabelText("Mesajınız"), { target: { value: "Kargo?" } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
  await screen.findByText("Kargo iki gün.");
  fireEvent.click(screen.getByRole("button", { name: "Yeni sohbet" }));
  expect(screen.queryByText("Kargo iki gün.")).toBeNull();
});
it("keeps the draft after an API error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Tekrar deneyin" }), { status: 503 })));
  render(<TestPage store={store} />);
  fireEvent.change(screen.getByLabelText("Mesajınız"), { target: { value: "Merhaba" } });
  fireEvent.click(screen.getByRole("button", { name: "Gönder" }));
  await screen.findByRole("alert");
  await waitFor(() => expect((screen.getByLabelText("Mesajınız") as HTMLTextAreaElement).value).toBe("Merhaba"));
});
