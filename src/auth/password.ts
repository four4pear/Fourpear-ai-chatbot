import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

// scrypt parametreleri özetle birlikte saklanır; ileride artırılırsa eski şifreler de doğrulanır.
// OWASP'ın scrypt önerisinin bellek dostu eşdeğeri: N=2^14, r=8, p=5 (N=2^17, p=1 ile aynı güvenlik, 16 MB bellek).
const PARAMS = { N: 16384, r: 8, p: 5 };
const KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 10;

/** Biçim: scrypt$N$r$p$<tuz base64>$<özet base64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Saklı özet güncel parametrelerden zayıfsa true: giriş yapınca özet yenilenir. */
export function needsRehash(stored: string): boolean {
  const [algo, N, r, p] = stored.split("$");
  return algo !== "scrypt" || Number(N) < PARAMS.N || Number(r) < PARAMS.r || Number(p) < PARAMS.p;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

/** Kullanıcı yoksa da aynı süre harcansın diye (hangi e-postaların kayıtlı olduğu anlaşılmasın). */
export const DUMMY_HASH =
  "scrypt$16384$8$5$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(KEYLEN).toString("base64");

/** Çerez ve linklerde kullanılan tahmin edilemez anahtar. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Veritabanında anahtarın kendisi değil bu özet saklanır. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
