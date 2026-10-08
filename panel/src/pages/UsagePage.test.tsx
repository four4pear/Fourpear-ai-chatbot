// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { durationLabel } from "./StatsSection";
import { UsagePage } from "./UsagePage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const store = { tenantId: "t", slug: "s", name: "Betül Saday", role: "owner" as const };

const STATS = {
  days: 7, conversations: 40, solvedByLina: 30, team: 10, avgResponseMinutes: 75, afterHours: 6,
  reasons: [{ label: "Şikayet", count: 4 }, { label: "Lina ekibe soru sordu", count: 3 }],
  bucketSize: "day" as const,
  buckets: [{ key: "2026-10-07", solved: 12, team: 3 }, { key: "2026-10-08", solved: 18, team: 7 }],
};
const USAGE = { days: 7, rows: [], totals: [{ source: "live", costUsd: 0, replies: 0, perReplyUsd: null, cacheHitRate: null }] };

function server(stats: unknown = STATS) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return url.includes("/stats") ? json(typeof stats === "function" ? (stats as (u: string) => unknown)(url) : stats) : json(USAGE);
  }));
  return urls;
}

it("sayılar, dönüş süresi, sebepler ve grafik görünür", async () => {
  server();
  render(<UsagePage store={store} />);
  await screen.findByText("40");
  expect(screen.getByText("30")).toBeTruthy();
  expect(screen.getByText("%75")).toBeTruthy();
  expect(screen.getByText("1 sa 15 dk")).toBeTruthy();
  const reasons = screen.getByRole("heading", { name: "Ekibe giden işlerin sebepleri" }).closest("section")!;
  expect(within(reasons).getByText("Şikayet").nextSibling?.textContent).toBe("4");
  expect(screen.getByRole("img", { name: /Günlük konuşmalar: 30 Lina çözdü, 10 ekibe gitti/ })).toBeTruthy();
});

it("dönem değişince istatistik o dönemle yeniden istenir", async () => {
  const urls = server();
  render(<UsagePage store={store} />);
  await screen.findByText("40");
  fireEvent.click(screen.getByRole("tab", { name: "Son 24 saat" }));
  await vi.waitFor(() => expect(urls.some((u) => u.includes("/stats?days=1"))).toBe(true));
  expect(urls.some((u) => u.includes("/usage?days=1"))).toBe(true);
});

it("konuşma yoksa grafik yerine açıklama; ekip yazmadıysa dönüş süresi çizgi", async () => {
  server({ ...STATS, conversations: 0, solvedByLina: 0, team: 0, avgResponseMinutes: null, afterHours: 0, reasons: [], buckets: [] });
  render(<UsagePage store={store} />);
  await screen.findByText("Bu dönemde müşteri yazmadı.");
  expect(screen.getByText("Bu dönemde ekibe giden iş yok.")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
});

it("süre yazımı", () => {
  expect([null, 0.4, 20, 60, 125, 60 * 30].map(durationLabel)).toEqual(["—", "1 dk’dan az", "20 dk", "1 sa", "2 sa 5 dk", "1 gün"]);
});
