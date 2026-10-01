import { describe, expect, it, vi } from 'vitest';
import { uygulamaOlustur, gunTR } from '../src/uygulama.js';
import { BUNDLE_ID, IOS_URUN_ID } from '../src/apple.js';
import { ANDROID_URUN_ID } from '../src/google.js';

/** Bellek içi sahte veri: users, ogrenciler, ilerleme, baglantilar. */
function kur(ekstra = {}) {
  const users = {
    elif: { rol: 'ogrenci', ad: 'Elif', fcmTokens: ['t-elif'] },
    ali: { rol: 'ogrenci', ad: 'Ali' },
    veli1: { rol: 'veli', ad: 'Ayşe Hanım' },
    veli2: { rol: 'veli', ad: 'Murat Bey' },
    ogt1: { rol: 'ogretmen', ad: 'Zeynep Öğretmen' },
    yabanci: { rol: 'veli', ad: 'Yabancı' },
  };
  const baglantilar = [
    { ogrenciUid: 'elif', izleyiciUid: 'veli1', rol: 'veli' },
    { ogrenciUid: 'elif', izleyiciUid: 'veli2', rol: 'veli' },
    { ogrenciUid: 'elif', izleyiciUid: 'ogt1', rol: 'ogretmen' },
  ];
  const ilerleme = { 'elif/carpanlar-katlar': { basamak: 'bitti' }, 'elif/uslu-ifadeler': { basamak: 'orta' } };
  const gorulen = new Set();
  const gonderimler = [];
  const d = {
    cronSecret: 'gizli-cron',
    saat: () => new Date('2026-09-26T17:00:00Z'),
    kimlikDogrula: vi.fn(async (t) => (t.startsWith('gecerli-') ? { uid: t.slice(8) } : null)),
    kullanici: vi.fn(async (u) => users[u] || null),
    ogrenci: vi.fn(async () => null),
    ilerleme: vi.fn(async (s, k) => ilerleme[`${s}/${k}`] || null),
    baglantiVar: vi.fn(async (s, i) => baglantilar.some((b) => b.ogrenciUid === s && b.izleyiciUid === i)),
    izleyiciler: vi.fn(async (s) => baglantilar.filter((b) => b.ogrenciUid === s)),
    birKez: vi.fn(async (a) => (gorulen.has(a) ? false : (gorulen.add(a), true))),
    gonder: vi.fn(async (uidler, mesaj) => {
      gonderimler.push({ uidler, mesaj });
      return { gonderilen: uidler.length, silinen: 0 };
    }),
    abonelikYaz: vi.fn(async () => {}),
    apple: vi.fn(),
    google: vi.fn(),
    googleOnayla: vi.fn(async () => {}),
    hesabiSil: vi.fn(async () => ({ baglanti: 1, kod: 0, geribildirim: 0, kayit: 0 })),
    gunKilidi: vi.fn(async () => true),
    hareketsizOgrenciler: vi.fn(async () => []),
    ...ekstra,
  };
  return { d, isle: uygulamaOlustur(d), gonderimler, users };
}

const post = (yol, uid, govde) => ({
  yontem: 'POST',
  yol,
  basliklar: uid ? { authorization: `Bearer gecerli-${uid}` } : {},
  govde,
});

describe('kimlik', () => {
  it('/saglik açık', async () => {
    const { isle } = kur();
    const r = await isle({ yontem: 'GET', yol: '/saglik' });
    expect(r.durum).toBe(200);
    expect(r.veri.ok).toBe(true);
  });

  it('jetonsuz ve geçersiz jetonla 401', async () => {
    const { isle } = kur();
    expect((await isle(post('/bildir', null, {}))).durum).toBe(401);
    expect((await isle({ yontem: 'POST', yol: '/bildir', basliklar: { authorization: 'Bearer sahte' } })).durum).toBe(401);
    expect((await isle(post('/satinalma/dogrula', null, {}))).durum).toBe(401);
  });

  it('bilinmeyen yol 404, yanlış yöntem 405', async () => {
    const { isle } = kur();
    expect((await isle({ yontem: 'GET', yol: '/yok' })).durum).toBe(404);
    expect((await isle({ yontem: 'GET', yol: '/bildir' })).durum).toBe(405);
  });
});

describe('POST /bildir — yetki ve hedef seçimi', () => {
  it('konuBitti: öğrencinin kendisi çağırır, tüm izleyicilere gider', async () => {
    const { isle, gonderimler } = kur();
    const r = await isle(post('/bildir', 'elif', { tur: 'konuBitti', ogrenciUid: 'elif', konuId: 'carpanlar-katlar' }));
    expect(r.durum).toBe(200);
    expect(r.veri.hedefler.sort()).toEqual(['ogt1', 'veli1', 'veli2']);
    expect(gonderimler).toHaveLength(1);
    expect(gonderimler[0].mesaj.govde).toBe('Elif Çarpanlar ve Katlar konusunu bitirdi. Raporu hazır.');
    expect(gonderimler[0].uidler).not.toContain('elif');
  });

  it('konuBitti: istemci metni yok sayılır', async () => {
    const { isle, gonderimler } = kur();
    await isle(post('/bildir', 'elif', { tur: 'konuBitti', ogrenciUid: 'elif', konuId: 'carpanlar-katlar', metin: 'kötü içerik' }));
    expect(gonderimler[0].mesaj.govde).not.toContain('kötü');
  });

  it('konuBitti: aynı olay ikinci kez bildirilmez', async () => {
    const { isle, gonderimler } = kur();
    const g = { tur: 'konuBitti', ogrenciUid: 'elif', konuId: 'carpanlar-katlar' };
    await isle(post('/bildir', 'elif', g));
    const r = await isle(post('/bildir', 'elif', g));
    expect(r.veri.tekrar).toBe(true);
    expect(gonderimler).toHaveLength(1);
  });

  it('konuBitti: ilerleme bitti değilse 409', async () => {
    const { isle } = kur();
    const r = await isle(post('/bildir', 'elif', { tur: 'konuBitti', ogrenciUid: 'elif', konuId: 'uslu-ifadeler' }));
    expect(r.durum).toBe(409);
  });

  it('başkası adına öğrenci olayı: izleyici bile olsa 403', async () => {
    const { isle, gonderimler } = kur();
    for (const uid of ['veli1', 'ali', 'yabanci']) {
      const r = await isle(post('/bildir', uid, { tur: 'konuBitti', ogrenciUid: 'elif', konuId: 'carpanlar-katlar' }));
      expect(r.durum).toBe(403);
    }
    expect(gonderimler).toHaveLength(0);
  });

  it('basamakGecti: geçilen basamak ilerlemeden çıkarılır', async () => {
    const { isle, gonderimler } = kur();
    const r = await isle(post('/bildir', 'elif', { tur: 'basamakGecti', ogrenciUid: 'elif', konuId: 'uslu-ifadeler' }));
    expect(r.durum).toBe(200);
    expect(gonderimler[0].mesaj.govde).toBe('Elif Üslü İfadeler konusunda basit basamağını geçti.');
  });

  it('basamakGecti: ilerleme yoksa 409', async () => {
    const { isle } = kur();
    const r = await isle(post('/bildir', 'elif', { tur: 'basamakGecti', ogrenciUid: 'elif', konuId: 'ucgenler' }));
    expect(r.durum).toBe(409);
  });

  it('geribildirim: bağlı veli yazar; öğrenciye ve DİĞER izleyicilere gider, yazana gitmez', async () => {
    const { isle, gonderimler } = kur();
    const r = await isle(post('/bildir', 'veli1', { tur: 'geribildirim', ogrenciUid: 'elif', metin: 'Aferin kızım!' }));
    expect(r.durum).toBe(200);
    expect(r.veri.hedefler.sort()).toEqual(['elif', 'ogt1', 'veli2']);
    const ogrenciye = gonderimler.find((g) => g.uidler.includes('elif'));
    expect(ogrenciye.uidler).toEqual(['elif']);
    expect(ogrenciye.mesaj.govde).toBe('Ayşe Hanım: "Aferin kızım!"');
    const digerlerine = gonderimler.find((g) => !g.uidler.includes('elif'));
    expect(digerlerine.uidler.sort()).toEqual(['ogt1', 'veli2']);
    expect(digerlerine.mesaj.govde).toContain('Elif için not yazdı');
    expect(gonderimler.flatMap((g) => g.uidler)).not.toContain('veli1');
  });

  it('geribildirim: bağlı olmayan izleyici veya öğrencinin kendisi 403', async () => {
    const { isle, gonderimler } = kur();
    expect((await isle(post('/bildir', 'yabanci', { tur: 'geribildirim', ogrenciUid: 'elif', metin: 'x' }))).durum).toBe(403);
    expect((await isle(post('/bildir', 'elif', { tur: 'geribildirim', ogrenciUid: 'elif', metin: 'x' }))).durum).toBe(403);
    expect(gonderimler).toHaveLength(0);
  });

  it('geçersiz tur / konu / öğrenci', async () => {
    const { isle } = kur();
    expect((await isle(post('/bildir', 'elif', { tur: 'baska', ogrenciUid: 'elif' }))).durum).toBe(400);
    expect((await isle(post('/bildir', 'elif', { tur: 'konuBitti', ogrenciUid: 'elif', konuId: 'yok' }))).durum).toBe(400);
    expect((await isle(post('/bildir', 'veli1', { tur: 'geribildirim', ogrenciUid: 'veli2' }))).durum).toBe(404);
    expect((await isle(post('/bildir', 'veli1', { tur: 'geribildirim' }))).durum).toBe(400);
  });
});

describe('POST /satinalma/dogrula — App Store aboneliği', () => {
  const makbuz = 'x'.repeat(40);
  const SIMDI = Date.parse('2026-09-26T17:00:00Z');
  const GUN = 24 * 60 * 60 * 1000;
  const makbuzYaniti = (bitis) => ({
    status: 0,
    ortam: 'Production',
    receipt: { bundle_id: BUNDLE_ID, in_app: [] },
    latest_receipt_info: [{ product_id: IOS_URUN_ID, transaction_id: '1', original_transaction_id: '1000', expires_date_ms: String(bitis) }],
  });
  const jws = (yuk) => `e30.${Buffer.from(JSON.stringify(yuk)).toString('base64url')}.imza`;

  it('etkin abonelik: bitiş tarihi yazılır', async () => {
    const { isle, d } = kur();
    d.apple.mockResolvedValue(makbuzYaniti(SIMDI + 30 * GUN));
    const r = await isle(post('/satinalma/dogrula', 'elif', { receipt: makbuz }));
    expect(r.durum).toBe(200);
    expect(r.veri).toEqual({ ok: true, aktif: true, bitis: SIMDI + 30 * GUN });
    expect(d.abonelikYaz).toHaveBeenCalledWith('elif', {
      platform: 'ios', islem: '1000', ortam: 'Production', bitis: SIMDI + 30 * GUN, aktif: true, durum: 'aktif',
    });
  });

  it('süresi dolmuş abonelik: durum kaydedilir, 400 abonelik_aktif_degil', async () => {
    const { isle, d } = kur();
    d.apple.mockResolvedValue(makbuzYaniti(SIMDI - GUN));
    const r = await isle(post('/satinalma/dogrula', 'elif', { receipt: makbuz }));
    expect(r.durum).toBe(400);
    expect(r.veri.hata).toBe('abonelik_aktif_degil');
    expect(d.abonelikYaz.mock.calls[0][1].aktif).toBe(false);
  });

  it('yanlış bundle / ürün yok / geçersiz durum reddedilir; ortak sır hatası 503', async () => {
    for (const [sonuc, durum, hata] of [
      [{ ...makbuzYaniti(SIMDI + GUN), receipt: { bundle_id: 'com.baska' } }, 400, 'yanlis_uygulama'],
      [{ ...makbuzYaniti(SIMDI + GUN), latest_receipt_info: [{ product_id: 'baska', expires_date_ms: '1' }] }, 400, 'urun_bulunamadi'],
      [{ status: 21003 }, 400, 'makbuz_gecersiz'],
      [{ status: 21004 }, 503, 'apple_ortak_sir_hatali'],
    ]) {
      const { isle, d } = kur();
      d.apple.mockResolvedValue(sonuc);
      const r = await isle(post('/satinalma/dogrula', 'elif', { receipt: makbuz }));
      expect(r.durum).toBe(durum);
      expect(r.veri.hata).toBe(hata);
      expect(d.abonelikYaz).not.toHaveBeenCalled();
    }
  });

  it('App Store Server API tanımlıysa transactionId ile sorar', async () => {
    const appleApi = vi.fn(async () => ({
      bulundu: true,
      ortam: 'Sandbox',
      veri: {
        bundleId: BUNDLE_ID,
        data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: jws({ productId: IOS_URUN_ID, originalTransactionId: '77', expiresDate: SIMDI + GUN }) }] }],
      },
    }));
    const { isle, d } = kur({ appleApi });
    const r = await isle(post('/satinalma/dogrula', 'elif', { transactionId: '123456' }));
    expect(r.durum).toBe(200);
    expect(appleApi).toHaveBeenCalledWith('123456');
    expect(d.apple).not.toHaveBeenCalled();
    expect(d.abonelikYaz.mock.calls[0][1]).toMatchObject({ islem: '77', aktif: true, ortam: 'Sandbox' });
  });

  it('Server API başarısızsa makbuzla dener', async () => {
    const appleApi = vi.fn(async () => ({ bulundu: false, httpDurum: 404 }));
    const { isle, d } = kur({ appleApi });
    d.apple.mockResolvedValue(makbuzYaniti(SIMDI + GUN));
    const r = await isle(post('/satinalma/dogrula', 'elif', { transactionId: '123456', receipt: makbuz }));
    expect(r.durum).toBe(200);
    expect(d.apple).toHaveBeenCalled();
  });

  it('makbuz eksik 400, öğrenci değil 403, Apple erişilemez 502', async () => {
    const { isle, d } = kur();
    expect((await isle(post('/satinalma/dogrula', 'elif', {}))).durum).toBe(400);
    expect((await isle(post('/satinalma/dogrula', 'elif', { transactionId: '123' }))).durum).toBe(400); // Server API yok
    expect((await isle(post('/satinalma/dogrula', 'veli1', { receipt: makbuz }))).durum).toBe(403);
    d.apple.mockRejectedValue(new Error('ağ'));
    expect((await isle(post('/satinalma/dogrula', 'elif', { receipt: makbuz }))).durum).toBe(502);
  });
});

describe('POST /satinalma/dogrula — Google Play aboneliği', () => {
  const jeton = 'gp-jeton-'.repeat(4);
  const govde = { platform: 'android', purchaseToken: jeton, productId: ANDROID_URUN_ID };
  const abonelik = (ekstra = {}, bitis = '2026-10-26T17:00:00Z') => ({
    bulundu: true,
    abonelik: {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      latestOrderId: 'GPA.1234-5678',
      lineItems: [{ productId: ANDROID_URUN_ID, expiryTime: bitis, offerDetails: { basePlanId: 'aylik-temel' } }],
      ...ekstra,
    },
  });

  it('geçerli jeton: Google\'a sorar, onaylar, bitiş tarihini yazar', async () => {
    const { isle, d } = kur();
    d.google.mockResolvedValue(abonelik());
    const r = await isle(post('/satinalma/dogrula', 'elif', govde));
    expect(r.durum).toBe(200);
    expect(r.veri).toEqual({ ok: true, aktif: true, bitis: Date.parse('2026-10-26T17:00:00Z'), onaylandi: true });
    expect(d.google).toHaveBeenCalledWith({ purchaseToken: jeton, productId: ANDROID_URUN_ID });
    expect(d.googleOnayla).toHaveBeenCalledWith({ purchaseToken: jeton, productId: ANDROID_URUN_ID });
    expect(d.abonelikYaz).toHaveBeenCalledWith('elif', {
      platform: 'android', islem: 'GPA.1234-5678', ortam: 'Production', bitis: Date.parse('2026-10-26T17:00:00Z'), aktif: true, durum: 'aktif',
    });
    expect(d.apple).not.toHaveBeenCalled();
  });

  it('zaten onaylıysa yeniden onaylamaz; test satın alımı işaretlenir', async () => {
    const { isle, d } = kur();
    d.google.mockResolvedValue(abonelik({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', testPurchase: {} }));
    const r = await isle(post('/satinalma/dogrula', 'elif', govde));
    expect(r.durum).toBe(200);
    expect(d.googleOnayla).not.toHaveBeenCalled();
    expect(d.abonelikYaz.mock.calls[0][1].ortam).toBe('Test');
  });

  it('onaylama başarısızsa hak yine verilir, onaylandi:false döner', async () => {
    const { isle, d } = kur();
    d.google.mockResolvedValue(abonelik());
    d.googleOnayla.mockRejectedValue(new Error('500'));
    const r = await isle(post('/satinalma/dogrula', 'elif', govde));
    expect(r.durum).toBe(200);
    expect(r.veri.onaylandi).toBe(false);
    expect(d.abonelikYaz).toHaveBeenCalled();
  });

  it('süresi dolmuş: kaydedilir, onaylanmaz, 400', async () => {
    const { isle, d } = kur();
    d.google.mockResolvedValue(abonelik({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }, '2026-09-01T00:00:00Z'));
    const r = await isle(post('/satinalma/dogrula', 'elif', govde));
    expect(r.durum).toBe(400);
    expect(r.veri.hata).toBe('abonelik_aktif_degil');
    expect(d.abonelikYaz.mock.calls[0][1].aktif).toBe(false);
    expect(d.googleOnayla).not.toHaveBeenCalled();
  });

  it('bekleyen ödeme 409, geçersiz jeton 400', async () => {
    for (const [sonuc, durum, hata] of [
      [abonelik({ subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }), 409, 'odeme_bekliyor'],
      [{ bulundu: false, httpDurum: 410 }, 400, 'jeton_gecersiz'],
    ]) {
      const { isle, d } = kur();
      d.google.mockResolvedValue(sonuc);
      const r = await isle(post('/satinalma/dogrula', 'elif', govde));
      expect(r.durum).toBe(durum);
      expect(r.veri.hata).toBe(hata);
      expect(d.abonelikYaz).not.toHaveBeenCalled();
      expect(d.googleOnayla).not.toHaveBeenCalled();
    }
  });

  it('eksik jeton / yanlış ürün 400, öğrenci değil 403, Google erişilemez 502, yapılandırma yok 503', async () => {
    const { isle, d } = kur();
    expect((await isle(post('/satinalma/dogrula', 'elif', { platform: 'android' }))).veri.hata).toBe('jeton_eksik');
    expect((await isle(post('/satinalma/dogrula', 'elif', { ...govde, productId: 'baska' }))).veri.hata).toBe('urun_bulunamadi');
    expect((await isle(post('/satinalma/dogrula', 'veli1', govde))).durum).toBe(403);
    d.google.mockRejectedValue(new Error('ağ'));
    expect((await isle(post('/satinalma/dogrula', 'elif', govde))).durum).toBe(502);
    const y = kur({ google: undefined });
    expect((await y.isle(post('/satinalma/dogrula', 'elif', govde))).durum).toBe(503);
  });
});

describe('POST /hesap/sil', () => {
  const simdiSn = Math.floor(new Date('2026-09-26T17:00:00Z').getTime() / 1000);
  const kimlik = (authTime) => vi.fn(async (t) => (t.startsWith('gecerli-') ? { uid: t.slice(8), authTime } : null));

  it('yeni giriş yapmış kullanıcının hesabını rolüyle siler', async () => {
    const { isle, d } = kur({ kimlikDogrula: kimlik(simdiSn - 60) });
    const r = await isle(post('/hesap/sil', 'veli1', { onay: 'SIL' }));
    expect(r.durum).toBe(200);
    expect(r.veri.ok).toBe(true);
    expect(d.hesabiSil).toHaveBeenCalledWith('veli1', 'veli');
  });

  it('belgesi olmayan (yarım kayıt) kullanıcı da silinir', async () => {
    const { isle, d } = kur({ kimlikDogrula: kimlik(simdiSn) });
    expect((await isle(post('/hesap/sil', 'hayalet', { onay: 'SIL' }))).durum).toBe(200);
    expect(d.hesabiSil).toHaveBeenCalledWith('hayalet', null);
  });

  it('onaysız 400, eski oturum 401, kimliksiz 401, GET 405', async () => {
    const { isle, d } = kur({ kimlikDogrula: kimlik(simdiSn - 11 * 60) });
    expect((await isle(post('/hesap/sil', 'elif', {}))).durum).toBe(400);
    const eski = await isle(post('/hesap/sil', 'elif', { onay: 'SIL' }));
    expect(eski.durum).toBe(401);
    expect(eski.veri.hata).toBe('yeniden_giris_gerekli');
    expect((await isle(post('/hesap/sil', null, { onay: 'SIL' }))).durum).toBe(401);
    expect((await isle({ yontem: 'GET', yol: '/hesap/sil' })).durum).toBe(405);
    expect(d.hesabiSil).not.toHaveBeenCalled();
  });
});

describe('POST /cron/hareketsizlik', () => {
  it('sır olmadan 401', async () => {
    const { isle } = kur();
    expect((await isle({ yontem: 'POST', yol: '/cron/hareketsizlik', basliklar: {} })).durum).toBe(401);
    expect((await isle({ yontem: 'POST', yol: '/cron/hareketsizlik', basliklar: { 'x-cron-secret': 'yanlis' } })).durum).toBe(401);
  });

  it('3-4 gün önce aktif olan öğrenciye ve izleyicilerine gönderir', async () => {
    const { isle, d, gonderimler } = kur({
      hareketsizOgrenciler: vi.fn(async () => [{ sid: 'elif', ad: 'Elif' }]),
    });
    const r = await isle({ yontem: 'POST', yol: '/cron/hareketsizlik', basliklar: { 'x-cron-secret': 'gizli-cron' } });
    expect(r.durum).toBe(200);
    const [alt, ust] = d.hareketsizOgrenciler.mock.calls[0];
    expect(ust.toISOString()).toBe('2026-09-23T17:00:00.000Z');
    expect(alt.toISOString()).toBe('2026-09-22T17:00:00.000Z');
    expect(gonderimler[0].uidler).toEqual(['elif']);
    expect(gonderimler[1].uidler.sort()).toEqual(['ogt1', 'veli1', 'veli2']);
    expect(gonderimler[1].mesaj.govde).toBe('Elif 3 gündür soru çözmedi. Küçük bir hatırlatma iyi gelebilir.');
  });

  it('günlük kilit alınamazsa atlar', async () => {
    const { isle, d } = kur({ gunKilidi: vi.fn(async () => false) });
    const r = await isle({ yontem: 'POST', yol: '/cron/hareketsizlik', basliklar: { 'x-cron-secret': 'gizli-cron' } });
    expect(r.veri.atlandi).toBe('bugun_calisti');
    expect(d.hareketsizOgrenciler).not.toHaveBeenCalled();
  });

  it('TR tarihi', () => {
    expect(gunTR(new Date('2026-09-26T22:30:00Z'))).toBe('2026-09-27');
  });
});
