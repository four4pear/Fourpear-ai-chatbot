import type { WaTarget } from "./conversation.js";

/**
 * Art arda mesajlar için cevap zamanlayıcısı (docs/lina-davranis.md "Art arda mesajlar").
 *
 * - Her müşteri mesajında bekleme baştan başlar (mağaza ayarı, varsayılan 30 sn); süre dolunca
 *   son cevaptan beri gelen bütün mesajlara TEK cevap hazırlanır.
 * - Cevap hazırlanırken yeni mesaj gelirse hazırlanan iptal edilir (Claude isteği yarıda kesilir),
 *   bekleme yeniden başlar, sonra hepsi birlikte cevaplanır.
 * - Üst sınır (varsayılan 180 sn): ilk cevapsız mesajdan sonra bu süre dolduysa artık iptal edilmez;
 *   hazırlanan cevap gider, sonradan gelenler hemen ardından ayrıca cevaplanır (durmadan yazan
 *   müşteri de cevap alır).
 * - Konuşma başına aynı anda tek cevap; "kuşak" sayacı eski bir cevabın gönderilmesini engeller.
 * - Bekleme boyunca WhatsApp'ın "yazıyor…" göstergesi (25 sn'de kaybolur) yenilenir.
 *
 * Tek sunucu için bellek içi; sunucu yeniden başlarsa bekleyenler açılışta yeniden kurulur
 * (findUnansweredConversations).
 */

export type RespondFn = (conversationId: string, ctl: { signal: AbortSignal; isCurrent: () => boolean }) => Promise<unknown>;

export type TypingTarget = { wa: WaTarget; messageId: string };

export type ScheduleInput = {
  delayMs: number;
  maxWaitMs: number;
  typing?: TypingTarget;
};

type Pending = {
  /** Her müşteri mesajında artar; cevap yalnızca kendi kuşağı hâlâ güncelse gönderilir. */
  generation: number;
  /** Bu turun ilk cevapsız mesajının zamanı (üst sınır buna göre). */
  firstAt: number;
  timer?: ReturnType<typeof setTimeout>;
  typingTimer?: ReturnType<typeof setInterval>;
  typing?: TypingTarget;
  running?: { controller: AbortController; done: Promise<void> };
  /** Üst sınır dolduktan sonra, hazırlanan cevap giderken gelen mesajlar: ardından ayrıca cevaplanır. */
  followUp?: { firstAt: number; delayMs: number; maxWaitMs: number };
};

export class ReplyScheduler {
  private pending = new Map<string, Pending>();

  constructor(
    private opts: {
      respond: RespondFn;
      /** "Yazıyor…" göstergesini yeniler; hata verirse sessizce geçilir. */
      refreshTyping?: (typing: TypingTarget) => Promise<void>;
      typingRefreshMs?: number;
      log: Pick<Console, "error">;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** Müşteri cevap bekleyen bir mesaj yazdı. */
  onCustomerMessage(conversationId: string, input: ScheduleInput) {
    const now = this.now();
    let p = this.pending.get(conversationId);
    if (!p) {
      p = { generation: 0, firstAt: now };
      this.pending.set(conversationId, p);
    }
    if (input.typing) p.typing = input.typing;
    this.startTypingRefresh(p);

    // Üst sınır dolmuşken cevap hazırlanıyorsa artık iptal edilmez (sonsuza kadar ertelenmesin).
    if (p.running && now >= p.firstAt + input.maxWaitMs) {
      p.followUp = { firstAt: p.followUp?.firstAt ?? now, delayMs: input.delayMs, maxWaitMs: input.maxWaitMs };
      return;
    }
    p.generation++;
    // Hazırlanan (henüz gönderilmemiş) cevap iptal: yeni mesajla birlikte yeniden hazırlanacak.
    p.running?.controller.abort();
    this.arm(conversationId, p, input.delayMs, input.maxWaitMs);
  }

  /** Bekleyen ya da hazırlanan cevabı iptal eder (ör. ekip konuşmayı devraldı). */
  cancel(conversationId: string) {
    const p = this.pending.get(conversationId);
    if (!p) return;
    p.running?.controller.abort();
    this.clear(conversationId, p);
  }

  /** Bu konuşma için bekleyen ya da hazırlanan cevap var mı? */
  isPending(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  /** Kapanışta: tüm zamanlayıcıları durdurur (bekleyenler açılışta yeniden kurulur). */
  stop() {
    for (const [id, p] of this.pending) {
      p.running?.controller.abort();
      this.clear(id, p);
    }
  }

  /** Testler için: bekleyen ve hazırlanan tüm cevaplar bitene kadar bekler. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size) {
      if (Date.now() > deadline) throw new Error("Zamanlayıcı boşalmadı");
      await Promise.all([...this.pending.values()].map((p) => p.running?.done));
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  private arm(conversationId: string, p: Pending, delayMs: number, maxWaitMs: number) {
    clearTimeout(p.timer);
    const now = this.now();
    const fireAt = Math.min(now + delayMs, p.firstAt + maxWaitMs);
    const generation = p.generation;
    p.timer = setTimeout(() => void this.fire(conversationId, generation), Math.max(0, fireAt - now));
  }

  private async fire(conversationId: string, generation: number) {
    const p = this.pending.get(conversationId);
    if (!p || p.generation !== generation) return;
    p.timer = undefined;

    const controller = new AbortController();
    let finished!: () => void;
    p.running = { controller, done: new Promise<void>((r) => (finished = r)) };
    try {
      await this.opts.respond(conversationId, {
        signal: controller.signal,
        isCurrent: () => this.pending.get(conversationId)?.generation === generation && !controller.signal.aborted,
      });
    } catch (err) {
      this.opts.log.error(`Cevap hazırlanamadı (${conversationId})`, err);
    } finally {
      finished();
      const current = this.pending.get(conversationId);
      if (current?.running?.controller === controller) current.running = undefined;
      // Arada yeni mesaj geldiyse yeni bir bekleme zaten kuruldu; yoksa tur bitti.
      if (current && current.generation === generation && !current.timer) {
        if (current.followUp) {
          const f = current.followUp;
          current.followUp = undefined;
          current.firstAt = f.firstAt;
          current.generation++;
          this.arm(conversationId, current, f.delayMs, f.maxWaitMs);
        } else {
          this.clear(conversationId, current);
        }
      }
    }
  }

  private startTypingRefresh(p: Pending) {
    if (p.typingTimer || !this.opts.refreshTyping) return;
    const refresh = this.opts.refreshTyping;
    p.typingTimer = setInterval(() => {
      if (p.typing) refresh(p.typing).catch(() => {});
    }, this.opts.typingRefreshMs ?? 20_000);
  }

  private clear(conversationId: string, p: Pending) {
    clearTimeout(p.timer);
    clearInterval(p.typingTimer);
    this.pending.delete(conversationId);
  }
}
