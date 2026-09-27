import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Biçim: v1:<iv>:<tag>:<şifreli metin>, hepsi base64.
export function encryptSecret(plain: string, masterKeyB64: string): string {
  const key = Buffer.from(masterKeyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(payload: string, masterKeyB64: string): string {
  const [version, iv, tag, enc] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !enc) throw new Error("Tanınmayan şifreli veri biçimi");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(masterKeyB64, "base64"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
}
