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

## Sohbetler
Ekranlar: **Tüm sohbetler** (liste: müşteri, durum, son mesaj; satıra tıklayınca konuşma açılır) ve **konuşma**
(mesajlar kimin yazdığıyla, müşterinin fotoğrafları, iç notlar ayrı; yanda Lina'nın devir özeti, ekibe iletilenler
ve Lina'nın uzmanlara sordukları). Devredilen konuşmalar ayrıca **Bekleyenler → Devredilen konuşmalar** bölümünde
listelenir. Konuşma ekranında **Devral**, mesaj yazma kutusu ve **Lina'ya geri ver** düğmeleri vardır; kurallar aşağıda.
Lina'nın cevap taslağı henüz yapılmadı.

- **Bekleyenler:** Lina'nın devrettiği, açık devri olan konuşmalar. Kimsenin devralmadığı en uzun bekleyen en üstte; devralınmış olanlar altta, kimde olduğu yazar.
- **Bende:** Benim devraldığım konuşmalar. **Tümü:** bütün konuşmalar, en son hareket eden üstte.
- **Devralma:** İlk tıklayan alır; Lina o konuşmada susar. Başkasının devraldığı konuşmayı yalnızca mağaza sahibi alabilir (çalışan izinde/meşgulse).
- **Bota geri ver:** Devralan kişi, mağaza sahibi ya da (henüz kimse devralmadıysa) herhangi bir ekip üyesi yapabilir. Açık devirler "çözüldü" olarak kapanır, Lina yeniden cevap verir.
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
- Yeni bir konuşma bekleyenlere düşünce: panelde sesli uyarı + tarayıcı/telefon bildirimi (izin istenir).
- Panel sayfa yenilemeden canlı güncellenir.

## Sipariş bildirimleri (Lina'nın ekibe bildirimleri)
Sipariş, iade, iptal ve şikayet konularında Lina konuşmayı devretmez; her soru ekibe bildirim olarak düşer
([lina-davranis.md §12](lina-davranis.md)). Önemli olanlar panelde **Bekleyenler → Ekibe iletilenler** bölümünde
listelenir; ekip işlemi yapınca "Tamamlandı" der. Sessiz kayıtların ekranı sohbet ekranıyla birlikte yapılacak.

| Tür | Önem |
|---|---|
| Şikayet, İade: ekip kararı gerekiyor, İptal isteği (kargoya verilmemiş), Değişiklik isteği, Sipariş bilgisine ulaşılamadı, Gecikme, Takip numarası yok, Günlük mesaj sınırı aşıldı | ⚠️ Önemli: sesli uyarı + tarayıcı bildirimi |
| İade/değişim isteği, İade durumu sorusu, Doğrulanamayan sipariş sorusu, Sipariş sorusu | Kayıt (sessiz) |

Lina'nın cevabı WhatsApp'a gönderilemediyse bildirim her durumda önemlidir ve `replyFailed` işaretlidir (müşteri cevap almadı).

- Her bildirimde: müşteri (ad, telefon), sipariş numaraları, müşterinin yazdıkları, Lina'nın cevabı, ayrıntılar (ör. "Gecikme: Lavin Etek (Siyah), planlanan kargo 25 Eylül 2026") ve konuşmaya bağlantı.
- **Aynı vaka bir kez düşer:** konuşmada aynı türde açık bildirim varsa yenisi açılmaz; o bildirim güncellenir (müşterinin yazdıkları birikir, Lina'nın son cevabı ve yeni ayrıntılar eklenir, sesli uyarı tekrarlanmaz). Ekip tamamladıktan sonra müşteri yine yazarsa yeni bildirim açılır.
- Mağazanın bütün ekibi görür (çalışan dahil); herkes "Tamamlandı" diyebilir, kimin kapattığı görünür.
- API: `GET /api/tenants/:id/notifications?filter=important&status=open|done`, `POST /api/tenants/:id/notifications/:nid/done`. Konuşma ayrıntısında o konuşmanın bildirimleri de gelir.
- Canlı olaylar: `notification` (yeni; `important` alanıyla, sesli uyarı buna göre), `notification_update` (tamamlandı ya da açık bildirim güncellendi).
