import type { FixedTextKey, TenantSettings } from "../db/schema.js";

/** Claude'dan geçmeden gönderilen metinlerin varsayılanları (mağaza panelden değiştirebilir). */
export const DEFAULT_TEXTS: Record<FixedTextKey, string> = {
  unsupported: "Şu an yazılı mesajları ve fotoğrafları anlayabiliyorum. Sorunuzu yazarak iletebilir misiniz?",
  dailyLimit:
    "Bugün için mesaj sınırına ulaştınız. Yarın tekrar yazabilirsiniz; acil bir durum varsa ekibimiz size buradan dönecektir.",
  failure:
    "Üzgünüm, sorunuzu şu an cevaplayamıyorum. Talebinizi ekibimize ilettim, en kısa sürede buradan size dönecekler.",
};

export function fixedText(settings: TenantSettings, key: FixedTextKey): string {
  return settings.texts[key]?.trim() || DEFAULT_TEXTS[key];
}
