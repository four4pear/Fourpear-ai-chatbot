import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { businessStatus } from "../src/core/business-hours.js";
import { startOfToday, toClaudeMessages } from "../src/core/conversation.js";
import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";
import { normalizePhone, samePhone } from "../src/lib/phone.js";
import { splitMessage } from "../src/whatsapp/client.js";
import { isValidSignature } from "../src/whatsapp/signature.js";

describe("imza doğrulama", () => {
  const body = Buffer.from('{"a":1}');
  const sig = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
  it("doğru imzayı kabul eder", () => expect(isValidSignature(body, sig, "secret")).toBe(true));
  it("yanlış anahtarı reddeder", () => expect(isValidSignature(body, sig, "other")).toBe(false));
  it("eksik/bozuk başlığı reddeder", () => {
    expect(isValidSignature(body, undefined, "secret")).toBe(false);
    expect(isValidSignature(body, "sha256=abc", "secret")).toBe(false);
  });
});

describe("telefon", () => {
  it("farklı yazımları aynı biçime getirir", () => {
    for (const v of ["+90 532 123 45 67", "0532 123 4567", "5321234567", "00905321234567", "905321234567"]) {
      expect(normalizePhone(v)).toBe("905321234567");
    }
  });
  it("kısa numaraları eşleştirmez", () => expect(samePhone("123", "123")).toBe(false));
});

describe("şifreleme", () => {
  const key = randomBytes(32).toString("base64");
  it("geri çözer", () => expect(decryptSecret(encryptSecret("EAAG-token", key), key)).toBe("EAAG-token"));
  it("yanlış anahtarla hata verir", () => {
    expect(() => decryptSecret(encryptSecret("x", key), randomBytes(32).toString("base64"))).toThrow();
  });
});

describe("mesaj bölme", () => {
  it("kısa metni bölmez", () => expect(splitMessage("merhaba")).toEqual(["merhaba"]));
  it("uzun metni sınırın altında parçalar", () => {
    const text = Array.from({ length: 300 }, (_, i) => `Paragraf ${i} ` + "x".repeat(40)).join("\n\n");
    const parts = splitMessage(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n\n")).toBe(text);
  });
});

describe("geçmiş dönüştürme", () => {
  it("rolleri birleştirir, sistem mesajlarını atlar, user ile başlar", () => {
    const out = toClaudeMessages([
      { sender: "bot", text: "önceki", type: "text" },
      { sender: "customer", text: "a", type: "text" },
      { sender: "customer", text: null, type: "image" },
      { sender: "system", text: "limit", type: "text" },
      { sender: "agent", text: "ekip cevabı", type: "text" },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "[müşteri fotoğraf gönderdi]" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "(Mağaza ekibi yazdı) ekip cevabı" }] },
    ]);
  });
});

describe("gün başlangıcı", () => {
  it("İstanbul saatine göre gece yarısını bulur", () => {
    // 2026-09-25 01:30 İstanbul = 2026-09-24 22:30 UTC
    const start = startOfToday("Europe/Istanbul", new Date("2026-09-24T22:30:00Z"));
    expect(start.toISOString()).toBe("2026-09-24T21:00:00.000Z");
  });
});

describe("ayarlar (.env)", () => {
  const required = { MASTER_KEY: randomBytes(32).toString("base64"), WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" };

  it("boş bırakılan isteğe bağlı satırları tanımsız sayar", () => {
    const config = loadConfig({ ...required, APP_URL: "", DATABASE_URL: " ", SHOPIFY_API_KEY: "", PORT: "" });
    expect(config.APP_URL).toBeUndefined();
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.PORT).toBe(3000);
  });

  it("boş bırakılan zorunlu satırı açıkça bildirir", () => {
    expect(() => loadConfig({ ...required, WHATSAPP_APP_SECRET: "" })).toThrow("WHATSAPP_APP_SECRET");
  });
});

describe("mesai hesabı (Pzt–Cmt 10:00–17:00)", () => {
  const hours = { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "17:00" };
  const at = (iso: string) => businessStatus(hours, "Europe/Istanbul", new Date(iso));

  it("mesai içinde açık", () => expect(at("2026-09-25T09:00:00Z")).toEqual({ open: true })); // Cuma 12:00
  it("sabah açılmadan önce bugün", () =>
    expect(at("2026-09-25T05:00:00Z")).toEqual({ open: false, nextOpening: "bugün saat 10:00" })); // Cuma 08:00
  it("17:00'de kapalı, yarın", () =>
    expect(at("2026-09-25T14:00:00Z")).toEqual({ open: false, nextOpening: "yarın saat 10:00" })); // Cuma 17:00
  it("cumartesi akşamı pazartesi", () =>
    expect(at("2026-09-26T16:00:00Z")).toEqual({ open: false, nextOpening: "pazartesi saat 10:00" }));
  it("pazar günü yarın (pazartesi)", () =>
    expect(at("2026-09-27T09:00:00Z")).toEqual({ open: false, nextOpening: "yarın saat 10:00" }));
});
