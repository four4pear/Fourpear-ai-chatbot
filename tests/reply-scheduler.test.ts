import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyScheduler, type RespondFn } from "../src/core/reply-scheduler.js";

const MIN = 60_000;
const input = { delayMs: MIN, maxWaitMs: 3 * MIN };
const typing = { wa: { phoneNumberId: "p", accessToken: "t", to: "905321234567" }, messageId: "wamid.1" };

/** Sahte cevap: her çağrıyı ve sinyalini kaydeder; `hold` true ise serbest bırakılana kadar bekler. */
function fakeRespond() {
  const calls: { signal: AbortSignal; isCurrent: () => boolean; sent: boolean }[] = [];
  let hold = false;
  const releases: (() => void)[] = [];
  const respond: RespondFn = async (_id, ctl) => {
    const call = { ...ctl, sent: false };
    calls.push(call);
    if (hold) {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        ctl.signal.addEventListener("abort", () => resolve());
      });
    }
    // Gerçek `respond` gibi: göndermeden önce hâlâ güncel mi diye bakar.
    if (ctl.isCurrent()) call.sent = true;
  };
  return {
    respond,
    calls,
    hold: (v: boolean) => (hold = v),
    release: () => releases.shift()?.(),
  };
}

let scheduler: ReplyScheduler;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  scheduler?.stop();
  vi.useRealTimers();
});

describe("cevap zamanlayıcısı (sahte saat)", () => {
  it("art arda 3 mesaj: son mesajdan 1 dk sonra TEK cevap", async () => {
    const f = fakeRespond();
    scheduler = new ReplyScheduler({ respond: f.respond, log: console });
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.onCustomerMessage("k1", input);

    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(f.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.sent).toBe(true);
    expect(scheduler.isPending("k1")).toBe(false);
  });

  it("59. saniyede gelen mesaj beklemeyi baştan başlatır", async () => {
    const f = fakeRespond();
    scheduler = new ReplyScheduler({ respond: f.respond, log: console });
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(59_000);
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.calls).toHaveLength(1);
  });

  it("durmadan yazan müşteri: ilk mesajdan en fazla 3 dk sonra cevap", async () => {
    const f = fakeRespond();
    scheduler = new ReplyScheduler({ respond: f.respond, log: console });
    for (let t = 0; t < 3 * MIN; t += 50_000) {
      scheduler.onCustomerMessage("k1", input);
      await vi.advanceTimersByTimeAsync(Math.min(50_000, 3 * MIN - t));
    }
    // 0, 50, 100, 150. saniyelerde mesaj; 180. saniyede (üst sınır) cevap.
    expect(f.calls).toHaveLength(1);
  });

  it("cevap hazırlanırken yeni mesaj: hazırlanan iptal, sonra tek cevap", async () => {
    const f = fakeRespond();
    scheduler = new ReplyScheduler({ respond: f.respond, log: console });
    f.hold(true);
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(f.calls).toHaveLength(1); // hazırlanıyor

    f.hold(false);
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls[0]!.signal.aborted).toBe(true);
    expect(f.calls[0]!.isCurrent()).toBe(false);
    expect(f.calls[0]!.sent).toBe(false); // iptal edilen gönderilmez

    await vi.advanceTimersByTimeAsync(MIN);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.sent).toBe(true);
  });

  it("üst sınırdan sonra gelen mesaj hazırlanan cevabı iptal etmez; ardından ayrıca cevaplanır", async () => {
    const f = fakeRespond();
    scheduler = new ReplyScheduler({ respond: f.respond, log: console });
    const capped = { delayMs: MIN, maxWaitMs: MIN }; // üst sınır = bekleme: cevap başlarken sınır dolmuş olur
    f.hold(true);
    scheduler.onCustomerMessage("k1", capped);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(f.calls).toHaveLength(1);

    f.hold(false);
    scheduler.onCustomerMessage("k1", capped);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls[0]!.signal.aborted).toBe(false); // iptal edilmedi

    f.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls[0]!.sent).toBe(true);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(f.calls).toHaveLength(2); // yeni mesaj ayrıca cevaplandı
    expect(f.calls[1]!.sent).toBe(true);
  });

  it("farklı müşteriler birbirini beklemez", async () => {
    const f = fakeRespond();
    scheduler = new ReplyScheduler({ respond: f.respond, log: console });
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.onCustomerMessage("k2", input);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.calls).toHaveLength(2);
  });

  it("bekleme boyunca 'yazıyor…' ~20 sn'de bir yenilenir, cevaptan sonra durur", async () => {
    const f = fakeRespond();
    const refreshed: string[] = [];
    scheduler = new ReplyScheduler({
      respond: f.respond,
      refreshTyping: async (t) => void refreshed.push(t.messageId),
      log: console,
    });
    scheduler.onCustomerMessage("k1", { ...input, typing });
    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(refreshed).toEqual(["wamid.1", "wamid.1"]); // 20. ve 40. saniye
    await vi.advanceTimersByTimeAsync(1); // cevap
    const afterReply = refreshed.length;
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(refreshed).toHaveLength(afterReply); // cevaptan sonra yenileme durur
  });

  it("ekip devralınca (cancel) bekleyen cevap gönderilmez", async () => {
    const f = fakeRespond();
    scheduler = new ReplyScheduler({ respond: f.respond, log: console });
    scheduler.onCustomerMessage("k1", input);
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.cancel("k1");
    expect(scheduler.isPending("k1")).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(f.calls).toHaveLength(0);
  });
});
