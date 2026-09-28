# Lina — WhatsApp AI Müşteri Hizmetleri

Mağazaların WhatsApp müşterilerine Claude ile cevap veren çok kiracılı (multi-tenant) servis.
Müşteriyle **Lina** konuşur; bilgiyi uzman ajanlardan alır, çözemediğini mağaza ekibine devreder.
Bilgiler elle yazılmaz: mağaza Shopify uygulamasını kurar, politikaları ve sayfaları otomatik çekilir.

**Durum:** Faz 1 tamam + Shopify bağlantısı: WhatsApp webhook, Lina + mağaza bilgi uzmanı (Shopify politikaları/sayfaları), Shopify kurulumu, fotoğraf, insana devir, mesai saatleri, günlük limit, kullanım kaydı.
Lina'nın tüm davranışları ve metinleri: [docs/lina-davranis.md](docs/lina-davranis.md).
Sırada: Faz 2 Shopify (sipariş + ürün ajanları), Faz 3 panel, Faz 4 ses/görsel/web arama/hatırlatıcı.

## Nasıl çalışır

```
WhatsApp → Meta → POST /webhook/whatsapp → imza kontrolü → 200
  → phone_number_id ile mağaza bulunur → mesaj kaydedilir (tekrar gelirse atlanır)
  → bot açık mı / konuşma devredildi mi / günlük limit? → Lina
      Lina ──► ask_store_info_agent (Shopify politikaları + sayfaları + mağaza notları)
           └─► handoff_to_human (konuşma "waiting" olur, bot susar)
  → cevap kaydedilir ve WhatsApp'a gönderilir
```

| Klasör | İçerik |
|---|---|
| `src/agents/` | Lina (yönlendirici), mağaza bilgi uzmanı, sistem istemleri, ortak Claude döngüsü (`runner.ts`) |
| `src/shopify/` | Shopify uygulaması: kurulum (OAuth, süreli token + yenileme), GraphQL istemcisi, bildirimler |
| `src/knowledge/` | Shopify'dan bilgi senkronu, HTML → metin, bilgi tabanı |
| `src/core/conversation.ts` | Bir müşteri mesajının uçtan uca işlenmesi |
| `src/whatsapp/` | Webhook tipleri, imza doğrulama, Graph API istemcisi |
| `src/db/` | Drizzle şeması (her tabloda `tenant_id`), bağlantı |
| `src/scripts/tenant.ts` | Panel gelene kadar mağaza ekleme / numara bağlama |
| `drizzle/` | Veritabanı migration'ları (açılışta otomatik uygulanır) |

## Yerelde çalıştırma

```bash
npm install
cp .env.example .env        # değerleri doldurun (MASTER_KEY üretme komutu dosyada)
npm test                    # 53 test, gerçek API çağırmaz
npm run dev
```

### Panel (mağaza ekibi)

```bash
npm run build && npm start          # sunucu + panel: http://localhost:3000
# ya da geliştirirken iki terminalde:
npm run dev                          # sunucu (3000)
npm run dev:panel                    # panel, canlı yenileme (http://localhost:5173)
```
İlk giriş için kendinize yönetici hesabı açın ve çıkan linkten şifrenizi belirleyin:
```bash
npm run tenant -- admin --email sen@ornek.com --name "Ad Soyad"
npm run tenant -- invite --slug maius --email sahip@maius.info --role owner   # mağaza sahibi daveti
```
Adresler: `/giris`, `/davet/<link>`, `/sifre/<link>`, `/m/<mağaza>/bekleyenler`, `/yonetici`.
Panel kodu `panel/` klasöründe (React + Vite); derlenmiş hali `panel/dist` sunucudan verilir.

### Lina ile terminalden konuşma (WhatsApp gerekmez)

```bash
npm run chat
```
Gerçek Claude, gerçek kurallar ve mağazanın Shopify'dan senkronlanmış bilgileriyle çalışır (`--slug maius`).
Konuşmalar bellekteki bir kopyada tutulur, gerçek kayıtlara karışmaz. `.env` içinde `ANTHROPIC_API_KEY` gerekir.
Uzman çağrılarını, devirleri ve mesaj başı maliyeti gösterir. Komutlar: `/foto <dosya> [açıklama]`,
`/saat 2026-09-26 19:30` (mesai testi), `/devral`, `/geri`, `/durum`, `/yeni`, `/ajan`, `/cik`.

> **Yerelde:** gömülü veritabanını aynı anda tek program açabilir. Sunucu (`npm run dev`) açıkken
> `npm run chat` ya da `npm run tenant` çalıştırırsanız "önce sunucuyu durdurun" uyarısı alırsınız.
> Canlıda (`DATABASE_URL` ile gerçek Postgres) bu kısıt yoktur.

`DATABASE_URL` boşsa gömülü PGlite (`./data/pglite`) kullanılır; ayrıca Postgres kurmanız gerekmez.

### Mağazayı ekleme (MAIUS)

```bash
npm run tenant -- upsert --slug maius --name MAIUS --domain maiusonline.com \
  --hours "1,2,3,4,5,6 10:00-17:00"               # günler: 0=pazar ... 6=cumartesi
npm run tenant -- whatsapp --slug maius --phone-number-id <PHONE_NUMBER_ID> --token <ERİŞİM_TOKEN>
npm run tenant -- shopify-link --slug maius --shop maius.myshopify.com   # imzalı kurulum linki (24 saat geçerli)
```
Mağaza sahibi linki açıp uygulamayı onaylar; bilgiler otomatik çekilir. Sonra:
```bash
npm run tenant -- docs --slug maius      # Lina'nın kullandığı kaynaklar (her soruda / gerekince / kapalı)
npm run tenant -- doc --slug maius --id <ilk 8 hane> --off   # bir kaynağı kapat (--on, --auto)
npm run tenant -- sync --slug maius      # siteyi güncelledikten sonra hemen yenile
npm run tenant -- alerts --slug maius    # Lina'nın bulduğu bilgi çelişkileri
npm run tenant -- upsert --slug maius --notes "Bu hafta kargolarda 2 gün gecikme var"   # Lina'ya notlar
```

## Shopify uygulaması kurulumu

1. [dev.shopify.com](https://dev.shopify.com) (Dev Dashboard) → **Create app**.
2. Uygulama ayarları:
   - **App URL:** `<APP_URL>` · **Redirect URL:** `<APP_URL>/shopify/callback`
   - **Embedded:** kapalı (panelimiz kendi adresinde çalışır)
   - **Compliance webhooks** (zorunlu): `customers/data_request`, `customers/redact`, `shop/redact` → `<APP_URL>/webhook/shopify`
3. **Client ID** → `SHOPIFY_API_KEY`, **Client secret** → `SHOPIFY_API_SECRET`.
4. Dağıtım: pilot için **Custom distribution** ile MAIUS'a özel kurulum linki; ileride App Store.
5. Müşteri telefonu/adı gibi alanlar için **Protected customer data** erişimi başvurusu (Faz 2 sipariş ajanı).

İstenen izinler `src/shopify/oauth.ts` içinde (`SHOPIFY_SCOPES`). Token'lar 60 dakikada bir otomatik yenilenir.
Shopify sayfa/politika değişikliği için bildirim göndermediğinden bilgiler 15 dakikada bir kontrol edilir.

## Meta (WhatsApp Cloud API) kurulumu

1. [developers.facebook.com](https://developers.facebook.com) → **Uygulama oluştur** → tür **Business** → **WhatsApp** ürününü ekleyin.
2. **WhatsApp → API Setup**: ücretsiz test numarası hazır gelir. **Phone Number ID** ve geçici token (24 saat geçerli) buradadır. "To" listesine kendi numaranızı ekleyin (test numarası yalnızca kayıtlı 5 alıcıya yazabilir).
3. **Uygulama ayarları → Temel → Uygulama Gizli Anahtarı** → `.env` içindeki `WHATSAPP_APP_SECRET`.
4. Sunucuyu dışarı açın: `npx ngrok http 3000`.
5. **WhatsApp → Configuration → Webhook**: URL `https://<ngrok-adresi>/webhook/whatsapp`, Verify Token = `.env` içindeki `WHATSAPP_VERIFY_TOKEN` → **Doğrula ve kaydet** → `messages` alanına abone olun.
6. Telefonunuzdan test numarasına WhatsApp'tan yazın.

**Kalıcı token:** business.facebook.com → Business Settings → System Users → admin kullanıcı → uygulamayı atayın → `whatsapp_business_messaging` ve `whatsapp_business_management` izinleriyle token üretin.

**Gerçek numara:** Başka bir WhatsApp hesabında kayıtlı olmayan bir numara ekleyin, işletme doğrulamasını ve görünen ad onayını tamamlayın.

## Davranış kuralları

Tamamı [docs/lina-davranis.md](docs/lina-davranis.md) içinde; kod bu belgeye göre yazılır. Özet:
- Lina yalnızca uzmanlardan gelen bilgiyi söyler; bilmediğinde hemen devreder.
- İade/iptal/değişim: koşulları özetler, bilgileri toplar, devreder. Şikayet: özür diler, fotoğraf ister, çözüm vaat etmeden devreder.
- Devir kuyruğunda Lina basit sorulara cevap vermeye devam eder; ekip devralınca susar.
- Devirde mesai saatine göre ne zaman dönüleceğini söyler.
- Claude hata verir ya da cevap üretemezse müşteriye özür mesajı gider ve konuşma otomatik devredilir.
- Her ajan çalıştırmasının token kullanımı `agent_runs` tablosuna yazılır (maliyet ve kota için).

## Canlıya alma (Railway)

Postgres eklentisi ekleyin, `DATABASE_URL` otomatik gelir. Diğer `.env` değerlerini girin.
Build: `npm run build`, Start: `npm start`. Migration'lar açılışta uygulanır.
