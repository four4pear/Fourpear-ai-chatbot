/**
 * Anahtar başına sıralı iş kuyruğu: aynı müşterinin art arda gelen mesajları
 * sırayla işlenir, farklı müşteriler paralel ilerler.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  constructor(private onError: (err: unknown, key: string) => void) {}

  push(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => this.onError(err, key))
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    this.tails.set(key, next);
    return next;
  }

  /** Bekleyen tüm işler bitince çözülür (testler ve kapanış için). */
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all([...this.tails.values()]);
  }
}
