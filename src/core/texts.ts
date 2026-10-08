import { looksEnglish, looksTurkish } from "../agents/prompts.js";
import type { FixedTextKey, TenantSettings } from "../db/schema.js";
import type { BusinessStatus } from "./business-hours.js";

/** Claude'dan geçmeden gönderilen metinlerin varsayılanları (mağaza panelden değiştirebilir). */
export const DEFAULT_TEXTS: Record<FixedTextKey, string> = {
  unsupported: "Şu an yazılı mesajları ve fotoğrafları anlayabiliyorum. Sorunuzu yazarak iletebilir misiniz?",
  failure:
    "Üzgünüm, şu an sorunuza cevap veremiyorum. Hemen kontrol ediyorum, kısa süre içinde size buradan bilgi vereceğim.",
};

/** Türkçe dışında yazan müşteriye giden varsayılanlar (mağaza kendi metnini yazdıysa o her dilde geçerlidir). */
const ENGLISH_TEXTS: Record<FixedTextKey, string> = {
  unsupported: "I can currently understand written messages and photos. Could you please send your question as text?",
  failure: "Sorry, I can't answer your question right now. I'm checking it and will get back to you here shortly.",
};

export type FixedTextContext = {
  /** Müşterinin son yazdığı mesajlar; dili buradan anlaşılır. Yazı yoksa (yalnızca ses) ya da dil belirsizse Türkçe varsayılır. */
  customerText?: string;
  /** İlk temasta metnin başına kısa tanıtım eklenir ("Merhaba, ben Lina."). */
  firstContact?: boolean;
  botName?: string;
  /** Mağaza kapalıysa "kısa süre içinde" sözü verilmez; ekibin ne zaman döneceği söylenir. */
  business?: BusinessStatus;
};

/**
 * Sabit metin. Mağaza kendi metnini yazdıysa o geçerlidir; yoksa müşterinin diline göre varsayılan (açıkça İngilizce ise
 * İngilizce, aksi hâlde Türkçe). Hata metninde mağaza kapalıysa söz mesaiye göre verilir. İlk temasta başa tanıtım eklenir.
 */
export function fixedText(settings: TenantSettings, key: FixedTextKey, ctx: FixedTextContext = {}): string {
  const custom = settings.texts[key]?.trim();
  const english = !custom && Boolean(ctx.customerText) && looksEnglish(ctx.customerText!);
  let text = custom || (english ? ENGLISH_TEXTS[key] : DEFAULT_TEXTS[key]);
  if (!custom && key === "failure" && ctx.business && !ctx.business.open) {
    const when = ctx.business.nextOpening;
    text = english
      ? "Sorry, I can't answer your question right now. Our team will get back to you here when the store opens."
      : `Üzgünüm, şu an sorunuza cevap veremiyorum. Ekibimiz ${when ? `${when}'dan itibaren` : "en kısa sürede"} size buradan dönecek.`;
  }
  return ctx.firstContact && ctx.botName ? withIntro(text, ctx.botName, english) : text;
}

function withIntro(text: string, botName: string, english: boolean): string {
  if (text.slice(0, 120).toLowerCase().includes(botName.toLowerCase())) return text;
  if (english) return `Hello, I'm ${botName}. ${text}`;
  // Türkçe metinde selam iki kez edilmez; başka dildeki özel metne Türkçe tanıtım eklenmez.
  return looksTurkish(text) ? ensureIntroTr(text, botName) : text;
}

function ensureIntroTr(text: string, botName: string): string {
  const rest = text.replace(/^(merhaba|selam|iyi günler|günaydın|iyi akşamlar)[,!.\s]*/i, "");
  const body = rest ? rest.charAt(0).toLocaleUpperCase("tr-TR") + rest.slice(1) : "";
  return `Merhaba, ben ${botName}.${body ? ` ${body}` : ""}`;
}
