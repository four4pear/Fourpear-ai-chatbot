import { createHmac, timingSafeEqual } from "node:crypto";

/** Meta'nın X-Hub-Signature-256 başlığını ham gövdeye karşı doğrular. */
export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
