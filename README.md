# Fourpear-ai-chatbot

Lina — WhatsApp AI Müşteri Hizmetleri

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

### Panelde test sohbeti

Mağaza sahibi veya yönetici hesabıyla `/m/<mağaza>/test` ekranını açın (menü: **Lina’yı test et**).
Gerçek mağaza bilgileri ve Claude ile metin sohbetini deneyebilirsiniz. Testler ayrı, geçici bir
veritabanında çalışır; müşteri kayıtlarına yazılmaz ve WhatsApp’a mesaj göndermez. Gerçek API kullanımı
ücretlidir. İsteğe bağlı deneme siparişleri, uzman çağrıları ve yeni sohbet düğmesi bulunur.
Cevaplar beklemeden hazırlanır; her istekte görünür metin geçmişi yeniden kurulur. Bu ekran
zamanlayıcı, fotoğraf ve ekip devralma akışlarını simüle etmez. En fazla 20 mesajdan sonra yeni sohbet açın.

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

### Siparişler, iade ve ekibe bildirimler

Shopify uygulaması kurulu mağazada Lina sipariş sorularını sipariş uzmanıyla cevaplar, konuşmayı devretmez; ekibe bildirim düşer (docs/lina-davranis.md §3, §12). Sipariş yalnızca müşterinin WhatsApp numarasıyla eşleşiyorsa gösterilir; tutar, ödeme ve adres hiç çekilmez.
```bash
npm run tenant -- upsert --slug maius --returns-url https://iade.betulsaday.com     # Lina'nın vereceği iade formu
npm run tenant -- returns --slug maius --url https://iade.betulsaday.com/mcp.php --store maius   # iade sistemi (anahtar gizli sorulur)
npm run tenant -- returns --slug maius --test      # bağlantı testi: anahtar hangi araçları görüyor?
npm run chat -- --demo-siparis                     # Shopify bağlı değilken deneme siparişleriyle dene
```
İade sistemi bağlantısı yalnızca okur (talep_ara, talep_detay); kupon, e-posta, durum değiştirme, ayar ve SQL araçları koddan çağrılamaz. Cevaptan müşteri adı, telefonu, adresi, IBAN/ödeme ve ekibin iç notları atılır.

### Kampanya arşivi

Ürün açıklamaları (kampanya, ön sipariş), etiketler, fiyatlar ve sitenin kampanya yazıları (üst bant, ana sayfa afişi) tarihleriyle saklanır. Kampanya bitip yazı silinse de o dönemdeki siparişler için yazı bulunur. Shopify uygulaması gerekmez; mağazanın `--domain` adresi yeterli. Sunucu açıkken 15 dakikada bir güncellenir (`ARCHIVE_SYNC_MINUTES`). Her güncellemede mağaza bilgi uzmanı için "Güncel kampanya ve duyuru yazıları" kaynağı da yenilenir.
```bash
npm run tenant -- archive --slug maius                              # vitrinden şimdi güncelle
npm run tenant -- archive-show --slug maius --title "Lavin Etek"    # bir ürünün sürümleri
npm run tenant -- archive-import --slug maius --products urunler.json --home anasayfa.html   # kaydedilmiş kopyayı işle
```

## Shopify uygulaması kurulumu

1. [dev.shopify.com](https://dev.shopify.com) (Dev Dashboard) → **Create app**.
2. Uygulama ayarları:
   - **App URL:** `<APP_URL>` · **Redirect URL:** `<APP_URL>/shopify/callback`
   - **Embedded:** kapalı (panelimiz kendi adresinde çalışır)
   - **Compliance webhooks** (zorunlu): `customers/data_request`, `customers/redact`, `shop/redact` → `<APP_URL>/webhook/shopify`
3. **Client ID** → `SHOPIFY_API_KEY`, **Client secret** → `SHOPIFY_API_SECRET`.
4. Dağıtım: pilot için **Custom distribution** ile MAIUS'a özel kurulum linki; ileride App Store.
5. **Protected customer data** (sipariş uzmanı için şart): önce dağıtım yöntemini seçin (Custom distribution), sonra **API access requests → Protected customer data access** bölümünde "Protected customer data"yı ve alan olarak **Phone**'u (panelde Shopify adını göstermek için **Name**'i de) seçip gerekçeyi yazın: "WhatsApp'tan yazan müşterinin siparişin sahibi olduğunu telefonla doğrulamak". Tek mağazaya özel (custom) uygulamada inceleme gerekmez. Telefon izni yoksa Lina hiçbir siparişi doğrulayamaz; sunucu kaydında "Protected customer data (telefon) izni verilmemiş olabilir" uyarısı çıkar.

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
- Sipariş, iade, iptal, değişim ve şikayet: konuşma devredilmez. Lina siparişi okur, ürünün kuralını söyler, gerekirse iade formu linkini verir ve ekibe bildirim düşer (onaylandı, sipariş uzmanıyla devreye girecek; o zamana kadar devreder).
- Kampanya yazıları tarihleriyle saklanır; siparişte o tarihteki kural geçerlidir.
- Devir kuyruğunda Lina basit sorulara cevap vermeye devam eder; ekip devralınca susar.
- Devirde mesai saatine göre ne zaman dönüleceğini söyler.
- Claude hata verir ya da cevap üretemezse müşteriye özür mesajı gider ve konuşma otomatik devredilir.
- Her ajan çalıştırmasının token kullanımı `agent_runs` tablosuna yazılır (maliyet ve kota için).

## Canlıya alma (Railway)

Postgres eklentisi ekleyin, `DATABASE_URL` otomatik gelir. Diğer `.env` değerlerini girin.
Build: `npm run build`, Start: `npm start`. Migration'lar açılışta uygulanır.
