# LGS Bağlam sunucusu

Render.com üzerinde çalışan küçük bir Node (20+) HTTP servisi. Push bildirimi (FCM),
App Store ve Google Play satın alma doğrulama, hesap silme ve günlük hareketsizlik
hatırlatmasını yapar.
Firestore, FCM ve kimlik doğrulama için `firebase-admin` kullanır. HTTP katmanı
Node'un yerleşik `http` modülüdür; başka çalışma zamanı bağımlılığı yoktur.

```
sunucu/
  src/sunucu.js       HTTP giriş noktası (npm start)
  src/uygulama.js     uçların mantığı (yetki, hedef seçimi, cron)
  src/firebase.js     firebase-admin bağımlılıkları
  src/bildirim.js     FCM gönderimi + geçersiz token temizliği
  src/apple.js        App Store abonelik doğrulama (Server API / verifyReceipt)
  src/google.js       Google Play abonelik doğrulama (subscriptionsv2, servis hesabı JWT'si)
  src/hesap.js        hesap silme (kullanıcının kendi verisi + Auth)
  src/metinler.js     konu adları ve bildirim metinleri
  scripts/hareketsizlik-cron.js   Render cron işinin çalıştırdığı betik
  test/               birim testleri (vitest)
  kural-testleri/     Firestore kural testleri (emülatör)
../render.yaml        Render Blueprint
../firestore.rules, ../firestore.indexes.json, ../firebase.json, ../.firebaserc
```

## Uçlar

Tüm uçlar `Authorization: Bearer <Firebase ID token>` bekler. İstisnalar: `/saglik`
ve cron ucu.

| Uç | Gövde | Ne yapar |
|---|---|---|
| `GET /saglik` | yok | `{ok:true}`. Render sağlık kontrolü. |
| `POST /bildir` | `{tur, ogrenciUid, konuId?, metin?}` | Hedefleri sunucu seçer (aşağıda). |
| `POST /satinalma/dogrula` | iOS: `{receipt?, transactionId?}` (base64 App Store makbuzu / StoreKit işlem kimliği). Android: `{platform:'android', purchaseToken, productId:'aylik'}` | Aboneliği Apple'a ya da Google Play'e sorar, `users/{uid}.abonelikBitis` ve durumunu yazar. |
| `POST /hesap/sil` | `{onay:'SIL'}` | Çağıranın hesabını ve kendi verisini siler. Oturum ≤ 10 dk önce açılmış olmalı. |
| `POST /cron/hareketsizlik` | yok; `x-cron-secret` başlığı | 3 gündür aktif olmayan öğrencilere ve izleyicilerine bildirim. `?zorla=1` günlük kilidi atlar. |

### /bildir kuralları

- `konuBitti`, `basamakGecti`: yalnızca öğrencinin kendisi çağırabilir (çağıran uid == `ogrenciUid`), yoksa **403**.
  Bildirim, öğrencinin tüm bağlı izleyicilerine (`baglantilar` sorgusu) gider.
  - `konuBitti`: `ogrenciler/{uid}/ilerleme/{konuId}.basamak` `'bitti'` değilse **409**. Metin: "Elif Çarpanlar ve Katlar konusunu bitirdi. Raporu hazır."
  - `basamakGecti`: geçilen basamak `ilerleme.basamak`tan çıkarılır (`orta` ise basit geçildi, `zor` ise orta, `bitti` ise zor). `basit` ya da ilerleme yoksa **409**. Metin: "Elif Üslü İfadeler konusunda basit basamağını geçti."
  - Aynı olay (öğrenci + tür + konu + basamak) için bildirim bir kez gider. Tekrarlanan çağrı `{ok:true, tekrar:true}` döner. Kayıt: `bildirimKayitlari/`.
  - İstemcinin gönderdiği `metin` bu türlerde yok sayılır.
- `geribildirim`: yalnızca `baglantilar/{ogrenciUid}_{cagiran}` belgesi olan veli veya öğretmen çağırabilir, yoksa **403**.
  Öğrenciye `Ayşe Hanım: "…"`, diğer izleyicilere (yazan hariç) `Ayşe Hanım, Elif için not yazdı: "…"` gider.
- Geçersiz `tur`/`konuId` için **400**, öğrenci yoksa **404**, kimlik yoksa **401**.
- FCM, kalıcı olarak geçersiz bir token bildirirse (`registration-token-not-registered`, `invalid-registration-token`) o token `users/{uid}.fcmTokens` dizisinden silinir.

### /satinalma/dogrula — aylık abonelik

Gelir modeli: otomatik yenilenen aylık abonelik (59 ₺). Abone olmayan öğrenci toplam 10 soru çözer
(`users/{uid}.ucretsizSoru`, kurallarla korunur). Sunucu mağazaya sorar ve durumu yazar:

- `users/{uid}`: `abonelikBitis` (Timestamp), `abonelikDurum` (`aktif`, `ek_sure`, `yenileme_kapali`, `faturalama_sorunu`, `askida`, `duraklatildi`, `suresi_doldu`, `iptal_iade`), `abonelikPlatform` (`ios`/`android`), `abonelikIslem`, `abonelikGuncelleme`.
- **Hak = `abonelikBitis` gelecekte.** Kurallar (`abone()`) ve istemci (`aboneMi()`) aynı ölçütü kullanır; süre dolunca başka bir yazım gerekmeden hak kalkar.
- Denetim: `satinalmalar/{kökİşlem}` → `uidler`, `platform`, `ortam`, `bitis`, `aktif`, `durum`. Aynı mağaza aboneliği birden çok hesapta kullanılırsa engellenmez, bu kayıttan görülür.
- Yalnızca `rol: 'ogrenci'` hesaplar (başkaları **403**).
- Abonelik bulundu ama süresi dolmuşsa durum yine yazılır ve **400** `abonelik_aktif_degil` (+`durum`, `bitis`) döner.

#### App Store (iOS)
- Bundle `com.yyapps.lgsbaglamtemelli`, ürün `com.yyapps.lgsbaglamtemelli.aylik` (abonelik grubu "LGS Bağlam Premium").
- Gövde `{receipt?, transactionId?}`. İstemci ikisini de yollar.
- **App Store Server API** (önerilen): `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` tanımlıysa ve `transactionId` geldiyse `GET /inApps/v1/subscriptions/{transactionId}` (ES256 JWT; önce üretim, 404 ise sandbox). `lastTransactions` içinden ürünümüzün en geç bitişli işlemi alınır; durum 1 (aktif) ve 4 (ek süre) hak verir, 5 (iade) ve `revocationDate` vermez. Sonuç alınamazsa makbuz yoluna düşülür.
  - TODO: `signedTransactionInfo` JWS imzası (x5c → Apple Root CA G3) şu an doğrulanmıyor; yanıt doğrudan Apple'dan TLS ile geldiği için yük güvenilir sayılıyor. App Store Server Notifications V2 eklenirse imza doğrulaması şarttır.
- **verifyReceipt** (yedek): `APPLE_SHARED_SECRET` ile (`password`). Önce `buy.itunes.apple.com`, `status: 21007` ise sandbox. `latest_receipt_info` içinden ürünün en geç `expires_date_ms` satırı; iade edilmiş (`cancellation_date`) satırlar sayılmaz; `pending_renewal_info.grace_period_expires_date_ms` ek süre olarak hesaba katılır. `21004` (ortak sır hatalı/eksik) **503** `apple_ortak_sir_hatali`.
- Hata yanıtları: `makbuz_eksik`, `makbuz_gecersiz` (+`appleDurum`), `yanlis_uygulama`, `urun_bulunamadi`, `islem_bulunamadi` (400), `apple_erisilemedi` (502).
- Not: Apple `verifyReceipt`i "deprecated" olarak işaretledi; Server API anahtarını tanımlamanız önerilir.

#### Google Play (Android)
- Paket `com.yyapps.lgsbaglamtemelli`, abonelik ürünü `aylik`, temel plan `aylik-temel` (aylık, otomatik yenilenen).
- Gövde `{platform:'android', purchaseToken, productId:'aylik'}`.
- `GET androidpublisher/v3/applications/{paket}/purchases/subscriptionsv2/tokens/{jeton}`. Kimlik: servis hesabıyla imzalanan JWT → OAuth erişim jetonu (kapsam `androidpublisher`, bağımlılık yok, `node:crypto`).
- `lineItems` içindeki `aylik` satırının `expiryTime` değeri bitiştir. `SUBSCRIPTION_STATE_ACTIVE`, `IN_GRACE_PERIOD` ve `CANCELED` (yenileme kapalı, dönem sürüyor) bitişe kadar hak verir; `ON_HOLD`, `PAUSED`, `EXPIRED` vermez. `PENDING` **409** `odeme_bekliyor`. Google 400/404/410 döndürürse **400** `jeton_gecersiz`.
- Etkin ve `acknowledgementState` `ACKNOWLEDGEMENT_STATE_PENDING` ise sunucu `purchases/subscriptions/aylik/tokens/{jeton}:acknowledge` çağırır. Onaylama başarısız olsa da hak verilir (`onaylandi:false`); istemcinin `finish()` çağrısı da onaylar. Onaylanmayan ilk satın alımı Google 3 gün sonra iade eder.
- İşlem kimliği: `latestOrderId` kökü (`GPA.x..N` → `GPA.x`); yoksa jeton özeti. `testPurchase` varsa `ortam: 'Test'`.
- Servis hesabı yoksa **503** `google_yapilandirilmadi`; Google'a ulaşılamazsa **502** `google_erisilemedi`.

#### Yenileme ve TODO
- Yenilemeler, uygulama açıldığında mağaza eklentisinin "approved" olayıyla istemciden aynı uca gelir ve bitişi ileri taşır. Uygulama hiç açılmazsa Firestore'daki bitiş eski kalır; bu yalnızca hakkın geç yansıması demektir (kullanıcı uygulamayı açınca düzelir).
- TODO (isteğe bağlı): App Store Server Notifications V2 ve Google Play Real-time Developer Notifications (Pub/Sub) uçları eklenirse yenileme/iptal/iade anında yansır. İade edilen aboneliğin hakkı şu an ancak bir sonraki doğrulamada kalkar.

### /hesap/sil

- App Store ve Google Play, hesap açılabilen uygulamalarda hesabın uygulama içinden silinebilmesini ister. Kurallar bu belgelerin istemciden silinmesine izin vermez; iş sunucudadır.
- Gövde `{onay:'SIL'}` olmalı (**400** `onay_gerekli`). ID token'ın `auth_time` değeri 10 dakikadan eskiyse **401** `yeniden_giris_gerekli` (istemci şifreyle yeniden doğrular ve yeni token alır).
- Silinenler: öğrenci için `ogrenciler/{uid}` ve tüm alt koleksiyonları, `baglantilar` (ogrenciUid), `baglantiKodlari`, `bildirimKayitlari/{uid}_*`; veli/öğretmen için kendi `baglantilar` belgeleri (öğrencinin sayacı 1 azaltılır) ve yazdığı `geribildirimler` (collection group sorgusu, `firestore.indexes.json` alan dizini gerekir). Herkes için `satinalmalar/*.uidler` içindeki uid, `users/{uid}` ve Auth kullanıcısı.

### Hareketsizlik (cron)

- Render cron işi `lgs-baglam-hareketsizlik` her gün 17:00 UTC'de (TR 20:00) `scripts/hareketsizlik-cron.js`'i çalıştırır. Betik `SUNUCU_URL/cron/hareketsizlik`'i `x-cron-secret` ile çağırır. Web servisi uyuyorsa uyanmasını bekler: 120 sn zaman aşımı ve 3 deneme.
- Hedef: `ogrenciler.sonAktif` değeri 4 gün önce ile 3 gün önce arasında olanlar. Böylece her hareketsizlik döneminde tek hatırlatma gider. Öğrenciye "3 gündür soru çözmedin…", izleyicilere "Elif 3 gündür soru çözmedi…" gider.
- Aynı gün iki kez çalışmaz (`sunucuDurumu/hareketsizlik_YYYY-AA-GG` kilidi).

## İstemcinin uyması gereken yazma biçimleri

Firestore kuralları (`../firestore.rules`) bunları zorunlu kılar. Aykırı yazma `permission-denied` alır.
Aşağıdaki iki madde MIMARI.md'deki modele **ek**tir: `baglantilar` belgesindeki `kod`
alanı ve öğrencinin `users` belgesindeki `veliSayisi` / `ogretmenSayisi` sayaçları.

### users/{uid}
- Oluşturma: `{rol: 'ogrenci'|'veli'|'ogretmen', ad (1–60 karakter), olusturma, fcmTokens?: string[]}`. Başka alanlar (ör. `eposta`) serbesttir.
- Abonelik alanları (`abonelikBitis`, `abonelikDurum`, `abonelikPlatform`, `abonelikIslem`, `abonelikGuncelleme`, eski `tamPaket`) istemci tarafından **hiçbir zaman** yazılamaz. `rol` sonradan değişmez.
- **Ücretsiz soru sayacı** `ucretsizSoru`: oluşturmada yok ya da 0. Öğrenci kendi belgesinde yalnızca bu alanı, tam `increment(1)` ile, en fazla 10'a kadar artırabilir; azaltma/sıfırlama yok.
- **Sayaçlar**: `veliSayisi`, `ogretmenSayisi` yalnızca öğrenci belgesinde bulunur. Oluşturmada ya hiç olmaz ya da 0'dır. Yalnızca aşağıdaki bağlanma ve koparma işlemlerinde ±1 değişir. Sınırlar: `veliSayisi ≤ 2`, `ogretmenSayisi ≤ 3`.
- Token eklemek için `arrayUnion` kullanın (`fcmTokens`).
- Okuma: kendisi ve (öğrenciyse) bağlı izleyicileri. Listeleme yok.

### Bağlantı kodu üretme (öğrenci)
```ts
setDoc(doc(db, 'baglantiKodlari', kod /* tam 6 rakam */), {
  ogrenciUid: uid,
  sonKullanma: Timestamp.fromMillis(Date.now() + 30 * 60_000), // Timestamp; en fazla 30 dk sonrası
  kullanildi: false,
  olusturma: serverTimestamp(), // isteğe bağlı
})
```
Başka alan yazılamaz. Kod zaten varsa oluşturma reddedilir; başka bir kod üretin.
Öğrenci kendi kodlarını `where('ogrenciUid','==',uid)` ile listeleyip silebilir.
Oturum açmış herkes tek bir kod belgesini `get` edebilir (bağlanmak için gerekir).

### Bağlanma (veli/öğretmen): tek `runTransaction`
```ts
await runTransaction(db, async (tx) => {
  const kodRef = doc(db, 'baglantiKodlari', kod)
  const k = await tx.get(kodRef)
  if (!k.exists() || k.data().kullanildi || k.data().sonKullanma.toMillis() <= Date.now()) throw new Error('kod')
  const sid = k.data().ogrenciUid
  tx.update(kodRef, { kullanildi: true, kullananUid: myUid })
  tx.set(doc(db, 'baglantilar', `${sid}_${myUid}`), {
    ogrenciUid: sid, izleyiciUid: myUid, rol: benimRolum /* users/{me}.rol */,
    kod,                        // ZORUNLU: kural kodu buradan doğrular
    olusturma: serverTimestamp(),
  })
  tx.update(doc(db, 'users', sid), {
    [benimRolum === 'veli' ? 'veliSayisi' : 'ogretmenSayisi']: increment(1),
  })
})
```
- `users/{sid}` bu işlemde **okunmaz**: henüz bağlı olmayan izleyicinin okuma izni yok. `increment(1)` kullanılır.
- Kural, işlem öncesi kodun kullanılmamış ve süresinin geçmemiş olduğunu, koddaki `ogrenciUid`nin bağlantı belgesindekiyle aynı olduğunu, işlem sonunda kodun `kullanildi: true` olduğunu ve sayacın tam 1 arttığını (`get`/`getAfter`) doğrular. Üç yazımdan biri eksikse işlem reddedilir.
- Sınır doluysa ya da zaten bağlıysa işlem `permission-denied` ile düşer. Kullanıcıya "Bu öğrencinin veli/öğretmen sınırı dolu ya da zaten bağlısınız" gösterin. Önceden `getDoc(doc(db,'baglantilar',`${sid}_${myUid}`))` ile kontrol edilebilir: kendi uid'inizi içeren bağlantı kimliğini belge yoksa bile sorgulayabilirsiniz.

### Bağlantı koparma (isteğe bağlı): `writeBatch`
```ts
batch.delete(doc(db, 'baglantilar', `${sid}_${izleyiciUid}`))
batch.update(doc(db, 'users', sid), {
  [rol === 'veli' ? 'veliSayisi' : 'ogretmenSayisi']: increment(-1),
  // yalnızca ÖĞRENCİ koparıyorsa:
  sonKaldirilan: izleyiciUid,
})
```

### Bağlantıları listeleme
İzleyici: `where('izleyiciUid','==',uid)`, öğrenci: `where('ogrenciUid','==',uid)`.

### ogrenciler/{sid} (yalnızca öğrencinin kendisi yazar)
- Yalnızca `{ad, sonAktif}`. `sonAktif` **Timestamp** olmalı (`serverTimestamp()`), çünkü cron bununla sorgular. Soru çözüldükçe güncelleyin.
- Okuma: öğrenci ve bağlı izleyiciler (alt koleksiyonlar dahil).

### ilerleme/{konuId}
- Anahtarlar yalnızca `basamak, basamaklar, baslangic, bitis, siradakiIndeks`. `basamak ∈ {basit, orta, zor, bitti}`, `basamaklar` map, `siradakiIndeks` int ≥ 0. `konuId` 12 geçerli kimlikten biri.
- Konu kilidi yoktur (12 geçerli kimlikten biri yeterli).

### cevaplar/{auto}: `addDoc`, sonradan değiştirilemez ve silinemez
Tüm alanlar zorunlu, fazlası yasak:
`{konuId (geçerli), soruId: string(1–100), aile: string|int, seviye: 'basit'|'orta'|'zor', secilen: 'A'|'B'|'C'|'D', dogru: bool, deneme: 1|2, hataTuru: 'kavram'|'islem'|'dikkat'|null, acele: bool, sureMs: int ≥ 0, ts: serverTimestamp()}`.
`sureMs` tam sayı olmalı (`Math.round`).
**Soru sınırı**: etkin abone (`users/{sid}.abonelikBitis > şimdi`) değilse `deneme: 1` cevabı ancak aynı `writeBatch` içinde `users/{sid}.ucretsizSoru` `increment(1)` ile artarsa yazılır (sayaç 10'daysa artış ve dolayısıyla cevap reddedilir). `deneme: 2` cevabı sayaç 1–10 arasındayken yazılır.
```ts
const b = writeBatch(db)
b.set(doc(collection(db, 'ogrenciler', uid, 'cevaplar')), cevap)
if (!abone && cevap.deneme === 1) b.update(doc(db, 'users', uid), { ucretsizSoru: increment(1) })
await b.commit()
```

### raporlar/{konuId}
İzinli anahtarlar: `konuId (= belge kimliği), konuAd, seviyeler (map), hataDagilimi (map), tekrarlayanHatalar (list), zorAileler (list), toplamSureMs (int), oneriler (list), aceleSayisi (int), zorlandi (list), olusturma`.

### geribildirimler/{auto}
- Yalnızca bağlı veli veya öğretmen yazar: `{yazanUid: myUid, yazanRol: bağlantıdaki rol, yazanAd (1–60), metin (1–2000), konuId?: geçerli kimlik, ts: serverTimestamp(), okundu: false}`.
- Öğrenci yalnızca `update({okundu: true})` yapabilir. Yazan kendi notunu silebilir.
- Yazdıktan sonra `POST /bildir {tur:'geribildirim', ogrenciUid, metin, konuId?}`.

### Sunucuyu çağırma sırası
- `ilerleme.basamak` yeni değere **yazıldıktan sonra** `/bildir` (`basamakGecti` / `konuBitti`) çağrılır. Sunucu durumu Firestore'dan okur.
- Abonelik sonrası `POST /satinalma/dogrula {receipt, transactionId}` → `{ok:true, aktif:true, bitis}` gelince `users/{uid}` belgesi (dinleyici) güncellenir.

İstemcinin sunucu adresi: `VITE_SUNUCU_URL=https://lgs-baglam-sunucu.onrender.com` (Render'ın verdiği gerçek adres; sonda `/` olmadan).

## Kurulum

### 1. Firebase servis hesabı JSON'u
1. [Firebase Console](https://console.firebase.google.com/) → **lgs-baglam-temelli** → ⚙ **Proje ayarları** → **Hizmet hesapları** sekmesi.
2. "Firebase Admin SDK" altında **Yeni özel anahtar oluştur** → JSON dosyası iner.
3. Bu dosya gizlidir. Depoya koymayın. Render'a tek satır olarak yapıştırılacak:
   `node -e "console.log(JSON.stringify(require('./indirilen.json')))"` çıktısını kopyalayın.

### 1b. Google Play servis hesabı (Android satın alma doğrulaması)
1. [Google Cloud Console](https://console.cloud.google.com/) → `lgs-baglam-temelli` projesi → **APIs & Services** → **Google Play Android Developer API**'yi etkinleştirin.
2. **IAM & Admin → Service Accounts** → yeni servis hesabı (rol gerekmez) → **Keys → Add key → JSON**. Dosya gizlidir, depoya koymayın.
3. Play Console → **Kullanıcılar ve izinler** → **Yeni kullanıcıları davet et** → servis hesabının e-postası → uygulama izni: "Finansal verileri görüntüleme" ve "Siparişleri ve abonelikleri yönetme".
4. JSON'u tek satır olarak Render'daki `GOOGLE_PLAY_SERVICE_ACCOUNT` değişkenine yapıştırın. Boş bırakılırsa `FIREBASE_SERVICE_ACCOUNT` kullanılır; o zaman 3. adımda Firebase Admin servis hesabının e-postasını davet edin.
5. İzinlerin etkinleşmesi birkaç saat sürebilir; o sürede Google 401/403 döner (sunucu **502**).

### 1c. App Store abonelik doğrulaması (iOS)
1. **Zorunlu:** App Store Connect → uygulama → **App Information** → **App-Specific Shared Secret** → Generate. Değeri Render'da `APPLE_SHARED_SECRET` değişkenine yazın (verifyReceipt otomatik yenilenen aboneliklerde bunu ister; yoksa **503** `apple_ortak_sir_hatali`).
2. **Önerilen:** App Store Connect → **Users and Access → Integrations → In-App Purchase** → anahtar oluşturun, `.p8` dosyasını indirin. Issuer ID → `APPLE_ISSUER_ID`, Key ID → `APPLE_KEY_ID`, `.p8` içeriği → `APPLE_PRIVATE_KEY` (tek satıra yapıştırılacaksa satır sonlarını `\n` yazın). Üçü de doluysa iOS doğrulaması App Store Server API ile yapılır.

### 2. APNs anahtarını FCM'ye yükleme (iOS push için)
1. [Apple Developer](https://developer.apple.com/account/resources/authkeys/list) → **Keys** → **+** → "Apple Push Notifications service (APNs)" işaretleyin → `.p8` dosyasını indirin. Key ID'yi ve Team ID'yi not edin.
2. Firebase Console → Proje ayarları → **Cloud Messaging** → **Apple uygulama yapılandırması** (`com.yyapps.lgsbaglamtemelli`) → **APNs Kimlik Doğrulama Anahtarı** → Yükle: `.p8`, Key ID, Team ID.
3. Xcode'da uygulamaya "Push Notifications" ve "Background Modes → Remote notifications" yeteneklerini ekleyin.

### 3. Render'a kurulum (Blueprint)
1. Depoyu GitHub/GitLab'a koyun. Render bir depoya bağlanmak ister; push'u siz yaparsınız.
2. Render → **New** → **Blueprint** → depoyu seçin. Kökteki `render.yaml` okunur ve iki servis oluşturulur:
   - `lgs-baglam-sunucu` (web, Frankfurt, free)
   - `lgs-baglam-hareketsizlik` (cron, `0 17 * * *`)
3. Panel `FIREBASE_SERVICE_ACCOUNT` ve `GOOGLE_PLAY_SERVICE_ACCOUNT` değerlerini sorar: 1. adımdaki ve 1b adımındaki tek satırlık JSON'ları yapıştırın. `APPLE_SHARED_SECRET` ile isteğe bağlı `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` değerlerini 1c adımına göre girin. `CRON_SECRET` otomatik üretilir ve cron işine `fromService` ile aktarılır.
4. Web servisinin adresi `https://lgs-baglam-sunucu.onrender.com` değilse (ad alınmışsa Render ek alır), cron işinin `SUNUCU_URL` değişkenini panelden düzeltin ve istemcideki `VITE_SUNUCU_URL`'i buna göre ayarlayın.
5. Doğrulama: `curl https://<adres>/saglik` → `{"ok":true,...}`. Cron'u elle denemek için Render panelinde cron işinde **Trigger Run** kullanın. Ya da: `curl -X POST -H "x-cron-secret: <değer>" https://<adres>/cron/hareketsizlik?zorla=1`.

**Ücretsiz plan notu:** Free web servisi 15 dakika istek almazsa uyur. Sonraki ilk istek yaklaşık 50 saniye sürer. Bu süre, uygulamadaki ilk bildirim ya da satın alma doğrulamasına yansır (istemcide zaman aşımını ≥ 60 sn tutun; `/bildir` çağrısını kullanıcıyı bekletmeden arka planda yapın). Aylık ücretsiz çalışma saatleri de sınırlıdır. **Starter** plana geçince servis hiç uyumaz, gecikme kalkar ve saat sınırı olmaz (aylık ücretli). Bunun için `render.yaml`'da `plan: starter` yapılır. Render cron işlerinin ücretsiz planı yoktur; çalıştığı süre kadar ücretlendirilir (küçük bir aylık alt sınırla). Maliyet istenmezse cron işi silinip `/cron/hareketsizlik` ucu dış bir zamanlayıcıdan (ör. cron-job.org, `x-cron-secret` başlığıyla) çağrılabilir.

### 4. Firestore kuralları ve dizinleri
Proje kökünde (`firebase-tools` gerekir). `npx firebase` yazmayın: o ad istemcinin Firebase JS SDK paketine çözülür.
```sh
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes   # .firebaserc → lgs-baglam-temelli
```

## Geliştirme ve test
```sh
cd sunucu
npm ci
npm test            # birim testleri (vitest; Firebase, Apple ve Google taklit edilir)
npm run check       # node --check ile sözdizimi kontrolü

cd kural-testleri
npm ci
npm test            # Firestore emülatörünü açar (Java 11+ gerekir); kural testleri + hesap silme (firebase-admin)
```
Yerelde gerçek sunucu: `FIREBASE_SERVICE_ACCOUNT="$(cat hesap.json)" GOOGLE_PLAY_SERVICE_ACCOUNT="$(cat play.json)" APPLE_SHARED_SECRET=... CRON_SECRET=deneme PORT=8787 npm start`.
