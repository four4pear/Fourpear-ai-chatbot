import { createHmac, randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { describeLlmError, runAgent, type Llm } from "../src/agents/runner.js";
import type { DB } from "../src/db/client.js";
import { loadConfig, whatsappConfigured } from "../src/config.js";
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

describe("yapay zekâ hataları", () => {
  it("ekibin anlayacağı kısa sebebe çevrilir", () => {
    const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });
    expect(describeLlmError(apiError(400, "Your credit balance is too low to access the Anthropic API."))).toContain("kredisi bitti");
    expect(describeLlmError(apiError(401, "invalid x-api-key"))).toBe("yapay zekâ anahtarı geçersiz");
    expect(describeLlmError(apiError(429, "rate limited"))).toBe("yapay zekâ kullanım sınırına takıldı");
    expect(describeLlmError(apiError(529, "Overloaded"))).toBe("yapay zekâ servisi geçici olarak yanıt vermiyor");
    expect(describeLlmError(new Error("beklenmeyen"))).toBe("teknik hata");
  });

  it("uzman aracının hatası sessiz kalmaz, kayda düşer", async () => {
    const warnings: string[] = [];
    let step = 0;
    const llm: Llm = {
      async create() {
        step++;
        const content =
          step === 1
            ? [{ type: "tool_use", id: "t1", name: "get_order", input: {} }]
            : [{ type: "text", text: "tamam", citations: null }];
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "x",
          content,
          stop_reason: step === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    };
    const db = { insert: () => ({ values: async () => {} }) } as unknown as DB;
    const result = await runAgent(
      { db, llm, model: "x", tenantId: "t", conversationId: null, log: { warn: (m: string) => warnings.push(m) } },
      {
        agent: "order",
        system: "s",
        messages: [{ role: "user", content: "?" }],
        effort: "low",
        tools: [
          {
            definition: { name: "get_order", input_schema: { type: "object", properties: {} } },
            run: async () => {
              throw new Error("Shopify GraphQL hatası (403): Access denied for phone field");
            },
          },
        ],
      },
    );
    expect(result.text).toBe("tamam");
    expect(warnings).toEqual(["[order] get_order aracı hata verdi: Shopify GraphQL hatası (403): Access denied for phone field"]);
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
  it("rolleri birleştirir, notları ve tepkileri atlar, otomatik mesajları tutar, user ile başlar", () => {
    const out = toClaudeMessages([
      { sender: "bot", text: "önceki", type: "text" },
      { sender: "customer", text: "a", type: "text" },
      { sender: "customer", text: null, type: "image" },
      { sender: "customer", text: null, type: "reaction" },
      { sender: "system", text: "Ayşe konuşmayı devraldı", type: "note" },
      { sender: "system", text: "limit", type: "text" },
      { sender: "agent", text: "ekip cevabı", type: "text" },
    ]);
    expect(out).toEqual([
      // Art arda müşteri mesajları tek yazı gibi: tek metin bloğunda satır satır.
      { role: "user", content: [{ type: "text", text: "a\n[müşteri fotoğraf gönderdi]" }] },
      { role: "assistant", content: [{ type: "text", text: "limit\n(Mağaza ekibi yazdı) ekip cevabı" }] },
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
    expect(() => loadConfig({ ...required, MASTER_KEY: "" })).toThrow("MASTER_KEY");
  });

  it("WhatsApp ayarları girilmeden de açılır (webhook kapalı kalır)", () => {
    const config = loadConfig({ MASTER_KEY: required.MASTER_KEY });
    expect(whatsappConfigured(config)).toBe(false);
    expect(whatsappConfigured(loadConfig(required))).toBe(true);
  });

  it("sunucu için eksiklerin hepsini tek seferde listeler; Railway'de Postgres şart", () => {
    const railway = { RAILWAY_ENVIRONMENT_NAME: "production" };
    let message = "";
    try {
      loadConfig(railway, { server: true });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Railway → servis → Variables");
    for (const name of ["MASTER_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL"]) expect(message).toContain(name);
    // Yerelde gömülü veritabanı serbest; komut satırı araçları Claude anahtarı istemez.
    expect(() => loadConfig({ MASTER_KEY: required.MASTER_KEY, ANTHROPIC_API_KEY: "k" }, { server: true })).not.toThrow();
    expect(() => loadConfig({ MASTER_KEY: required.MASTER_KEY })).not.toThrow();
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

describe("ensureIntro: ilk temasta tanıtım garantisi", () => {
  it("tanıtım yoksa Türkçe cevabın başına eklenir", async () => {
    const { ensureIntro } = await import("../src/agents/prompts.js");
    expect(ensureIntro("Bu tamamen bizim hatamız, çok özür dilerim.", "Lina")).toBe("Merhaba, ben Lina. Bu tamamen bizim hatamız, çok özür dilerim.");
  });
  it("tanıtım zaten varsa dokunmaz", async () => {
    const { ensureIntro } = await import("../src/agents/prompts.js");
    expect(ensureIntro("Merhaba, ben Lina. Hemen bakıyorum.", "Lina")).toBe("Merhaba, ben Lina. Hemen bakıyorum.");
  });
  it("başka dildeki cevaba Türkçe tanıtım eklenmez", async () => {
    const { ensureIntro } = await import("../src/agents/prompts.js");
    expect(ensureIntro("Hello! Yes, we ship worldwide within a few days.", "Lina")).toBe("Hello! Yes, we ship worldwide within a few days.");
  });
});
