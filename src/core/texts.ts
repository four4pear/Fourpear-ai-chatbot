import type { FixedTextKey, TenantSettings } from "../db/schema.js";

/** Claude'dan geçmeden gönderilen metinlerin varsayılanları (mağaza panelden değiştirebilir). */
export const DEFAULT_TEXTS: Record<FixedTextKey, string> = {
  unsupported: "Şu an yazılı mesajları ve fotoğrafları anlayabiliyorum. Sorunuzu yazarak iletebilir misiniz?",
  dailyLimit:
    "Bugün için mesaj sınırına ulaştınız. Yarın tekrar yazabilirsiniz; acil bir durum varsa ekibimiz size buradan dönecektir.",
  failure:
    "Üzgünüm, şu an sorunuza cevap veremiyorum. Hemen kontrol ediyorum, kısa süre içinde size buradan bilgi vereceğim.",
};

export function fixedText(settings: TenantSettings, key: FixedTextKey): string {
  return settings.texts[key]?.trim() || DEFAULT_TEXTS[key];
}
