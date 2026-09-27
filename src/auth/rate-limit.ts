/**
 * Basit bellek içi deneme sınırlayıcı: bir anahtar (e-posta ya da IP) için pencere içinde
 * en fazla `max` başarısız deneme. Tek sunucu için yeterli; çok sunucuda Postgres'e taşınır.
 */
export class FailureLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    if (now >= e.resetAt) {
      this.entries.delete(key);
      return false;
    }
    return e.count >= this.max;
  }

  fail(key: string, now = Date.now()) {
    const e = this.entries.get(key);
    if (!e || now >= e.resetAt) this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count++;
  }

  reset(key: string) {
    this.entries.delete(key);
  }
}
