# LGS Bağlam: mimari sözleşme

8. sınıf öğrencisi için bağlam temelli LGS matematik soruları. Öğrenci her konuda basitten zora ilerler. Konu sonunda bir rapor alır. Yanlışları işlem, dikkat ve kavram hatası olarak analiz edilir. Veli ve öğretmen, öğrencinin ürettiği 6 haneli kodla bağlanıp öğrenciyi izler ve geri bildirim yazar. Push bildirimleri gönderilir. Çarpanlar ve Katlar ücretsizdir; diğer 11 konu tek seferlik 999 ₺ ödemeyle açılır.

## Yığın
- İstemci: Vite + React 18 + TypeScript + Tailwind v4, Capacitor 8 (iOS ve Android). LGS Mentor ile aynı yığın; oradaki çalışan desenler uyarlanır. Referans: /home/claude/lgsmentor. Salt okunur, sadece örnek alınır.
- Firebase projesi: `lgs-baglam-temelli`. Kimlik doğrulama e-posta/şifre ile. Veritabanı Firestore.
- Sunucu: Cloudflare Worker (`sunucu/`). FCM HTTP v1 ile push, App Store makbuz doğrulama, cron ile hareketsizlik hatırlatması. firebase-admin kullanılmaz; Firestore ve FCM'ye REST ile erişilir (lgsmentor/cloudflare/src/google.js ve firestore.js uyarlanır).
- Bundle id `com.yyapps.lgsBaglam`, uygulama adı "LGS Bağlam". Ürün: `com.yyapps.lgsBaglam.tamPaket`, non-consumable, 999 ₺.

## İçerik
- Kaynak: `/mnt/project-files/baglam-temelli/uretim/sorular/<NN - Konu>/q{N}{,-basit,-zor}.json` ve aynı adlı `.svg` dosyaları. Üretim sürüyor, dosya sayısı artabilir.
- `scripts/icerik-derle.mjs` betiği şunları üretir:
  - `public/icerik/index.json`: `[{konuId, no, ad, ucretsiz, aileSayisi, soruSayisi}]`
  - `public/icerik/<konuId>.json`: `{konuId, ad, aileler: [{aile, kazanim, sorular: {basit?, orta, zor?}}]}`
- Her soruda uygulamaya giden alanlar: `id, aile, seviye, baglam_adi, baglam, svg (dosyanın içeriği), gorsel_aciklama, soru_koku, secenekler, dogru, cozum, ipuclari, hata_turleri, celdiriciler, kazanim, surec_bilesenleri`.
- Uygulamaya gitmeyenler: `dogrulama_kodu`, `tohum`, `yapi_etiketleri`.
- `ipuclari` veya `hata_turleri` alanı eksik olan eski sorularda istemci zarifçe davranır: ipucu yerine çeldirici gerekçesini gösterir, hata türünü `null` sayar.
- Klasörden konuId eşlemesi (NN önekine göre):
  01 carpanlar-katlar, 02 uslu-ifadeler, 03 karekoklu-ifadeler, 04 veri-analizi, 05 olasilik, 06 cebirsel-ifadeler, 07 dogrusal-denklemler, 08 esitsizlikler, 09 ucgenler, 10 eslik-benzerlik, 11 donusum-geometrisi, 12 geometrik-cisimler.
- Ücretsiz olan tek konu `carpanlar-katlar`.

## İlerleme kuralları
- Her konuda üç basamak vardır: `basit` → `orta` → `zor` → `bitti`. Bir basamağın soruları, o seviyede sorusu olan ailelerin hepsidir.
- Bir basamakta her soru için:
  1. İlk denemede doğru cevap verilirse sonraki soruya geçilir.
  2. İlk deneme yanlışsa seçilen şıkkın ipucu gösterilir ve ikinci deneme hakkı verilir.
  3. İkinci deneme de yanlışsa çözüm gösterilir.
- Basamak geçme ölçütü: ilk denemede doğru oranı en az %70. Oran altında kalırsa ilk denemede yanlış yapılan sorular yeniden sorulur (tekrar turu). Tekrar turunda doğru olan sorular "tekrar doğru" sayılır. Tekrar turu bitince basamak geçilir ve raporda "zorlandı" etiketi kalır. Amaç öğrenciyi kilitlemek değil, pekiştirmek.
- Seviye verisi eksikse (ör. ailenin basit sorusu yoksa) o basamak boş sayılır ve atlanır.
- Konu `bitti` durumuna geçince konu raporu yazılır ve `/bildir` üzerinden veli ve öğretmene push gider.

## Yanlış analizi
- Hata türü, seçilen şıkkın `hata_turleri` etiketinden gelir: `kavram | islem | dikkat`.
- Ek kural: cevap süresi 12 saniyenin altındaysa ve cevap yanlışsa kayıtta `acele: true` olur. Rapor bunu dikkat eksikliğinin destekleyici kanıtı olarak gösterir.
- Konu raporu içeriği:
  - Seviye bazında ilk deneme doğru oranı
  - Hata türü dağılımı
  - Tekrarlayan hata türü (aynı türde 2 veya daha fazla yanlış)
  - En zorlanılan aileler (kazanımlarıyla)
  - Toplam süre
  - Somut öneriler: her hata türü için sabit öneri metinleri, ayrıca en zorlanılan kazanımın adı.

## Veri modeli (Firestore)
- `users/{uid}`: `{rol: 'ogrenci'|'veli'|'ogretmen', ad, olusturma, fcmTokens: string[], tamPaket: bool (yalnızca sunucu yazar)}`
- `baglantiKodlari/{kod}`: öğrencinin ürettiği 6 haneli kod. `{ogrenciUid, sonKullanma (30 dk), kullanildi: false}`. Tek kullanımlıktır. Kodu giren veli veya öğretmen, bir işlemle (transaction) bağlantıyı kurar.
- `baglantilar/{ogrenciUid}_{izleyiciUid}`: `{ogrenciUid, izleyiciUid, rol, olusturma}`. Bir öğrencinin en fazla 2 velisi ve 3 öğretmeni olabilir.
- `ogrenciler/{sid}`: `{ad, sonAktif}`
  - `ilerleme/{konuId}`: `{basamak, basamaklar: {basit: {tamam, ilkDenemeDogru, toplam, tekrar}, ...}, baslangic, bitis, siradakiIndeks}`
  - `cevaplar/{auto}`: `{konuId, soruId, aile, seviye, secilen, dogru: bool, deneme: 1|2, hataTuru, acele, sureMs, ts}`
  - `raporlar/{konuId}`: rapor nesnesi. Öğrenci yazar; alanlar kural ile sınırlıdır.
  - `geribildirimler/{auto}`: `{yazanUid, yazanRol, yazanAd, metin, konuId?, ts, okundu}`. Veli veya öğretmen yazar, öğrenci okur. Push gider.
- Okuma yetkisi: öğrencinin kendisi ve bağlı izleyiciler (`baglantilar` belgesinin varlığıyla kontrol edilir). Yazma yetkisi yukarıdaki gibidir. `tamPaket` alanını yalnızca sunucu yazar.
- Kilit kuralı: öğrenci, `carpanlar-katlar` dışındaki bir konuya `cevaplar` veya `ilerleme` yazabilmek için `users/{uid}.tamPaket == true` olmalıdır.

## Sunucu uçları (Cloudflare Worker)
Tüm uçlar `Authorization: Bearer <Firebase ID token>` bekler.
- `POST /bildir`: `{tur: 'konuBitti'|'geribildirim'|'basamakGecti', ogrenciUid, konuId?, metin?}`. Hedefleri sunucu belirler: öğrencinin olayları izleyicilere, izleyicinin geri bildirimi öğrenciye ve diğer izleyicilere gider. Çağıran kişi ilgili taraf değilse 403 döner.
- `POST /satinalma/dogrula`: `{receipt}` → Apple makbuzu doğrulanır (önce üretim ortamı, 21007 dönerse sandbox) → `users/{uid}.tamPaket = true`.
- `GET /saglik`
- Cron (her gün 17:00 UTC, TR 20:00): 3 gündür aktif olmayan öğrenciye hatırlatma, izleyicilerine bilgi.
- Gizli değişkenler (`wrangler secret put`): `FIREBASE_SERVICE_ACCOUNT`, `CRON_SECRET`.

## Ekranlar
- Giriş/Kayıt: rol seçimi (öğrenci / veli / öğretmen).
- Öğrenci:
  - Konular: 12 konu kartı; basamak ilerlemesi; kilit rozeti; ücretsiz etiketi.
  - Konu yolculuğu: basit, orta ve zor basamakları; devam et.
  - Soru ekranı: bağlam, SVG görsel, kök, 4 şık, ipucu, ikinci deneme, çözüm.
  - Konu raporu.
  - Geri bildirimler (gelen kutusu).
  - Bağlantı kodu üret.
  - Ödeme ekranı.
- Veli/Öğretmen:
  - Kod gir.
  - Öğrencilerim.
  - Öğrenci detayı: konu ilerlemeleri, raporlar, son yanlışlar ve türleri.
  - Geri bildirim yaz.
- Görsel dil: kitapçıkla aynı palet (mürekkep #1F2A44, teal #2A9D8F, turuncu #F4A261/#E08A3C, mavi #457B9D). Fontlar: Lexend (başlık), Source Sans 3 (metin). SVG görseller her temada beyaz zemin üzerinde gösterilir.
