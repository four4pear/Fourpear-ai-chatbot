# Panel — Davranış Belgesi

Panelin çalışanlara ve mağaza sahiplerine nasıl davrandığı. Görsel taslak: "Lina Paneli Taslak" (claude.ai).
Lina'nın müşteriye davranışı ayrı belgede: [lina-davranis.md](lina-davranis.md).

## Roller
| Rol | Görebildikleri |
|---|---|
| Çalışan | Bekleyenler, tüm sohbetler |
| Mağaza sahibi | + İstatistik, Ayarlar, ekip (davet, şifre sıfırlama linki) |
| Yönetici (platform) | Tüm mağazalar, her mağazada sahip yetkisi |

Bir kişi birden fazla mağazada farklı rollerle olabilir (ör. ajans).

## Bekleyenler
Ekibin yapması gerekenler, üç bölümde; her bölümde en uzun bekleyen üsttedir ve her kart konuşmaya bağlantı verir.
- **Lina soruyor:** Lina'nın arka planda ekibe sorduğu sorular ([lina-davranis.md §15](lina-davranis.md)).
- **Ekibe iletilenler:** önemli bildirimler. "Tamamlandı" denince listeden düşer; hemen çıkan "Geri al" ile ya da "Tamamlananları göster" listesinden (kimin, ne zaman tamamladığı yazar) geri açılır.
- **Ekibi bekleyen konuşmalar:** açık devri olan konuşmalar (aşağıda) ve ekipteyken müşterinin yeniden yazdığı, kimsenin cevaplamadığı konuşmalar ("Müşteri … yazdı, cevap bekliyor").
- Menüdeki Bekleyenler simgesinde bekleyen iş sayısı görünür: açık sorular + açık önemli bildirimler + kimsenin devralmadığı devirler + ekipte cevap bekleyen müşteriler. Hangi sayfa açık olursa olsun 20 saniyede bir, her işlemden sonra ve sunucudan canlı olay (devir, bildirim, ekibe soru) gelince hemen yenilenir. Sayı **artarsa** (ilk yüklemede değil) ses çalar ve pencere arka plandaysa masaüstü bildirimi çıkar; sekme başlığında da "(3)" görünür. Üst çubuktaki **zil** bu uyarıyı açar/kapatır (tercih bu cihazda kalır); açarken deneme sesi çalar ve tarayıcı bildirim izni istenir. Bildirimde müşteri bilgisi yoktur, yalnızca "yeni iş geldi" ve toplam sayı yazar.
- Bir bölüm yüklenemezse diğerleri yine görünür. Oturum düşerse panel girişe döner.

## Sohbetler
Ekranlar: **Tüm sohbetler** (liste: müşteri, durum, son mesaj; satıra tıklayınca konuşma açılır; görünümler **Tümü / Ekibi bekleyen / Bende**, ad ya da telefonla arama) ve **konuşma**
(mesajlar kimin yazdığıyla, müşterinin fotoğrafları, iç notlar ayrı; yanda Lina'nın devir özeti, ekibe iletilenler
ve Lina'nın uzmanlara sordukları). Devredilen konuşmalar ayrıca **Bekleyenler → Devredilen konuşmalar** bölümünde
listelenir. Konuşma ekranında başlığın yanında **Devral** ve **Lina'ya geri ver**, mesajların altında yazma kutusu vardır; kurallar aşağıda.
Yanda ayrıca Lina'nın ekibe sorduğu açık sorular görünür ve ekibe iletilen talep oradan da "Tamamlandı" yapılabilir.
Yeni mesaj gelince ekran yalnızca kişi en alttaysa aşağı iner (eski mesajları okuyan yerinden edilmez).
Lina'nın cevap taslağı henüz yapılmadı.

- **Bekleyenler:** Lina'nın devrettiği, açık devri olan konuşmalar. Kimsenin devralmadığı en uzun bekleyen en üstte; devralınmış olanlar altta, kimde olduğu yazar.
- **Bende:** Benim devraldığım konuşmalar. **Tümü:** bütün konuşmalar, en son hareket eden üstte.
- **Devralma:** İlk tıklayan alır; Lina o konuşmada susar. Başkasının devraldığı konuşmayı yalnızca mağaza sahibi alabilir (çalışan izinde/meşgulse).
- **Lina'ya geri ver:** Devralan kişi, mağaza sahibi ya da (henüz kimse devralmadıysa) herhangi bir ekip üyesi yapabilir. Açık devirler "çözüldü" olarak kapanır; müşterinin cevapsız mesajı varsa Lina hemen cevaplar.
- **Cevap yazma:** Sadece konuşmayı devralan kişi yazabilir. Mesaj **imzasız**, mağaza adına gider.
- **24 saat kuralı (WhatsApp):** Müşterinin son mesajından 24 saat geçtiyse serbest mesaj gönderilemez; yazma kutusu kapanır ve nedeni yazar. (Meta onaylı şablon desteği sonra.)
- Devralma ve bota geri verme olayları sohbette not olarak görünür (müşteriye gitmez).

## Müşteri bilgisi
- **Ad:** Shopify'daki ad varsa o (sipariş ajanıyla gelecek), yoksa WhatsApp profil adı, o da yoksa numara.
- **Telefon:** Ekibe tam görünür.
- Müşterinin gönderdiği fotoğraflar sohbette görünür (yalnızca o mağazanın ekibine).

## Lina'nın cevap taslağı
- Konuşma devralınınca hazırlanır; müşteri yeni mesaj yazınca yenilenir.
- Çalışan "Taslağı kullan" ile yazma kutusuna alır, düzenleyip gönderir. Taslak kendiliğinden gönderilmez.

## Bildirimler
- Yeni bir konuşma bekleyenlere düşünce: panelde sesli uyarı + tarayıcı/telefon bildirimi (izin istenir). Uygulandı (6 Ekim 2026): bkz. menüdeki Bekleyenler rozeti ve zil düğmesi. Telefona anlık (kapalı sekme) bildirim için web push ayrıca gerekir, henüz yok.
- Panel sayfa yenilemeden canlı güncellenir.

## Sipariş bildirimleri (Lina'nın ekibe bildirimleri)
Sipariş, iade, iptal ve şikayet konularında Lina konuşmayı devretmez; her soru ekibe bildirim olarak düşer
([lina-davranis.md §12](lina-davranis.md)). Önemli olanlar panelde **Bekleyenler → Ekibe iletilenler** bölümünde
listelenir; ekip işlemi yapınca "Tamamlandı" der. Sessiz kayıtların ekranı sohbet ekranıyla birlikte yapılacak.

| Tür | Önem |
|---|---|
| Şikayet, İade: ekip kararı gerekiyor, İptal isteği (kargoya verilmemiş), Değişiklik isteği, Sipariş bilgisine ulaşılamadı, Gecikme, Takip numarası yok, Günlük mesaj sınırı aşıldı, Sipariş bulunamadı, Çok sayıda yanlış doğrulama denemesi, Müşteri cevap bekliyor (ekibe sorulan soru 20 dakikadır cevapsız) | ⚠️ Önemli: sesli uyarı + tarayıcı bildirimi |
| İade/değişim isteği, İade durumu sorusu, Doğrulanamayan sipariş sorusu, Sipariş sorusu | Kayıt (sessiz) |

Lina'nın cevabı WhatsApp'a gönderilemediyse bildirim her durumda önemlidir ve `replyFailed` işaretlidir (müşteri cevap almadı).

- Her bildirimde: müşteri (ad, telefon), sipariş numaraları, müşterinin yazdıkları, Lina'nın cevabı, ayrıntılar (ör. "Gecikme: Lavin Etek (Siyah), planlanan kargo 25 Eylül 2026") ve konuşmaya bağlantı.
- **Aynı vaka bir kez düşer:** konuşmada aynı türde ve **aynı siparişler için** açık önemli bildirim varsa yenisi açılmaz; o bildirim güncellenir (müşterinin yazdıkları birikir, Lina'nın son cevabı ve yeni ayrıntılar eklenir, sesli uyarı tekrarlanmaz) ve listede üste çıkar. Başka bir sipariş için istek ya da ekip tamamladıktan sonraki yazışma yeni bildirimdir. Sessiz kayıtlar birleştirilmez.
- **"Tamamlandı" görülmemiş isteği kapatmaz:** ekip kartı açtıktan sonra müşteri yeniden yazdıysa "Tamamlandı" reddedilir ("Bu talep siz bakarken güncellendi"), kart yenilenir; yeni hâline bakıp tekrar basılır.
- Mağazanın bütün ekibi görür (çalışan dahil); herkes "Tamamlandı" diyebilir, kimin kapattığı görünür.
- API: `GET /api/tenants/:id/notifications?filter=important&status=open|done`, `POST /api/tenants/:id/notifications/:nid/done`, `POST …/:nid/reopen`, `GET /api/tenants/:id/waiting-count`. Konuşma ayrıntısında o konuşmanın bildirimleri de gelir.
- Canlı olaylar: `notification` (yeni; `important` alanıyla, sesli uyarı buna göre), `notification_update` (tamamlandı ya da açık bildirim güncellendi).

## Ayarlar
Yalnızca mağaza sahibi. Şimdilik **Lina'yı aç/kapat** ve **Ekip** (üyeleri listele, davet linki oluştur, şifre linki üret, bekleyen daveti iptal et, ekipten çıkar) ve **Mesai saatleri** (günler, başlangıç, bitiş; "Lina yalnızca mesai saatlerinde cevap versin" seçeneği). Açma/kapatma (acil durdurma): kapalıyken Lina hiçbir müşteriye cevap vermez, mesajlar panelde görünür, ekip konuşmaları devralıp yazabilir; açılınca yalnızca yeni mesajlara cevap verilir. "Yalnızca mesai saatlerinde" açıkken mesai dışında gelen mesajlar kaydedilir, müşteriye hiçbir şey yazılmaz ve "yazıyor…" gösterilmez; mesai başlayınca (dakikada bir kontrol) Lina bekleyen mesajlara cevap verir. API: `GET/PATCH /api/tenants/:id/settings`. Lina'ya notlar, sabit metinler, günlük sınır ve ekip yönetimi sonraki adımlarda.

**Ekip kuralları:** davet ve şifre linki e-postayla gitmez; sahip linki kopyalayıp kişiye kendisi iletir (tek kullanımlık; davet 7 gün, şifre linki 24 saat). Kendini ve mağazanın son sahibini çıkaramazsın. Ekipten çıkarılan kişinin bu mağazaya erişimi hemen kapanır; başka mağazası yoksa oturumları da silinir. API: `GET /members` (bekleyen davetlerle), `DELETE /members/:id`, `DELETE /invites/:id`.
