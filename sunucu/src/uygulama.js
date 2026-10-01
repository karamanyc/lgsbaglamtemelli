// İstek işleyici — HTTP'den ve Firebase'den bağımsız. Tüm dış bağımlılıklar
// `d` ile gelir (src/firebase.js gerçeklerini kurar, testler taklitlerini).

import { timingSafeEqual } from 'node:crypto';
import { abonelikDurumunuDegerlendir, makbuzuDegerlendir } from './apple.js';
import { ANDROID_URUN_ID, googleSatinAliminiDegerlendir } from './google.js';
import { GECILEN_BASAMAK, KONULAR, metinler } from './metinler.js';

const GUN_MS = 24 * 60 * 60 * 1000;
const TURLER = new Set(['konuBitti', 'basamakGecti', 'geribildirim']);
/** Hesap silme için oturumun en fazla bu kadar önce açılmış olması gerekir. */
const YENI_GIRIS_SN = 10 * 60;

const yanit = (durum, veri) => ({ durum, veri });

/** Türkiye tarihi (UTC+3, yaz saati yok) — YYYY-AA-GG. */
export const gunTR = (tarih) => new Date(tarih.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

function sirEsit(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export function uygulamaOlustur(d) {
  const simdi = () => (d.saat ? d.saat() : new Date());

  async function cagiran(basliklar) {
    const h = basliklar.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    return d.kimlikDogrula(h.slice(7).trim());
  }

  async function ogrenciAdi(sid, kullanici) {
    if (kullanici?.ad) return kullanici.ad;
    const o = await d.ogrenci(sid);
    return o?.ad || 'Öğrenciniz';
  }

  // --- POST /bildir ---------------------------------------------------------
  async function bildir(uid, govde) {
    const { tur, ogrenciUid, konuId, metin } = govde || {};
    if (!TURLER.has(tur)) return yanit(400, { hata: 'tur_gecersiz' });
    if (typeof ogrenciUid !== 'string' || !ogrenciUid) return yanit(400, { hata: 'ogrenciUid_gerekli' });

    const ogrenci = await d.kullanici(ogrenciUid);
    if (!ogrenci || ogrenci.rol !== 'ogrenci') return yanit(404, { hata: 'ogrenci_bulunamadi' });

    if (tur === 'geribildirim') {
      // Yalnızca bu öğrenciye bağlı izleyici.
      if (uid === ogrenciUid || !(await d.baglantiVar(ogrenciUid, uid))) {
        return yanit(403, { hata: 'ilgili_taraf_degil' });
      }
      if (konuId !== undefined && konuId !== null && !KONULAR[konuId]) {
        return yanit(400, { hata: 'konuId_gecersiz' });
      }
      const yazan = await d.kullanici(uid);
      const yazanAd = yazan?.ad || (yazan?.rol === 'ogretmen' ? 'Öğretmenin' : 'Velin');
      const temizMetin = typeof metin === 'string' ? metin : '';
      const ogrAd = await ogrenciAdi(ogrenciUid, ogrenci);
      const digerleri = (await d.izleyiciler(ogrenciUid))
        .map((b) => b.izleyiciUid)
        .filter((i) => i !== uid);
      const veri = { tur, ogrenciUid, konuId: konuId || '' };
      const a = await d.gonder([ogrenciUid], { ...metinler.geribildirimOgrenciye(yazanAd, temizMetin), veri });
      const b = await d.gonder(digerleri, { ...metinler.geribildirimIzleyiciye(yazanAd, ogrAd, temizMetin), veri });
      return yanit(200, {
        ok: true,
        hedefler: [ogrenciUid, ...digerleri],
        gonderilen: a.gonderilen + b.gonderilen,
      });
    }

    // konuBitti / basamakGecti: yalnızca öğrencinin kendisi.
    if (uid !== ogrenciUid) return yanit(403, { hata: 'ilgili_taraf_degil' });
    if (!KONULAR[konuId]) return yanit(400, { hata: 'konuId_gecersiz' });

    const ilerleme = await d.ilerleme(ogrenciUid, konuId);
    let mesaj;
    let anahtar;
    if (tur === 'konuBitti') {
      if (ilerleme?.basamak !== 'bitti') return yanit(409, { hata: 'konu_bitmedi' });
      mesaj = metinler.konuBitti(await ogrenciAdi(ogrenciUid, ogrenci), konuId);
      anahtar = `${ogrenciUid}_konuBitti_${konuId}`;
    } else {
      const gecilen = GECILEN_BASAMAK[ilerleme?.basamak];
      if (!gecilen) return yanit(409, { hata: 'basamak_gecilmedi' });
      mesaj = metinler.basamakGecti(await ogrenciAdi(ogrenciUid, ogrenci), konuId, gecilen);
      anahtar = `${ogrenciUid}_basamakGecti_${konuId}_${gecilen}`;
    }

    // Aynı olay için izleyicilere bir kez bildirim gider.
    if (!(await d.birKez(anahtar))) return yanit(200, { ok: true, tekrar: true, gonderilen: 0, hedefler: [] });

    const hedefler = (await d.izleyiciler(ogrenciUid)).map((b) => b.izleyiciUid);
    const s = await d.gonder(hedefler, { ...mesaj, veri: { tur, ogrenciUid, konuId } });
    return yanit(200, { ok: true, hedefler, gonderilen: s.gonderilen });
  }

  // --- POST /satinalma/dogrula ---------------------------------------------
  // Aylık abonelik. iOS: {receipt?, transactionId?}. Android:
  // {platform: 'android', purchaseToken, productId?}. Mağazanın bildirdiği
  // bitiş tarihi users/{uid}.abonelikBitis'e yazılır; hak = bitiş gelecekte.
  async function satinalma(uid, govde) {
    const android = govde?.platform === 'android';
    if (android) {
      const t = govde?.purchaseToken;
      if (typeof t !== 'string' || t.length < 10 || t.length > 4096) return yanit(400, { hata: 'jeton_eksik' });
      if (govde.productId !== undefined && govde.productId !== ANDROID_URUN_ID) return yanit(400, { hata: 'urun_bulunamadi' });
    } else {
      const receipt = govde?.receipt;
      const islemId = govde?.transactionId;
      const makbuzVar = typeof receipt === 'string' && receipt.length >= 20;
      const islemVar = typeof islemId === 'string' && /^[0-9]{1,40}$/.test(islemId) && Boolean(d.appleApi);
      if (!makbuzVar && !islemVar) return yanit(400, { hata: 'makbuz_eksik' });
    }

    const kullanici = await d.kullanici(uid);
    if (!kullanici) return yanit(404, { hata: 'kullanici_bulunamadi' });
    if (kullanici.rol !== 'ogrenci') return yanit(403, { hata: 'yalnizca_ogrenci' });

    if (android) return googleSatinalma(uid, govde.purchaseToken);
    return appleSatinalma(uid, govde);
  }

  async function hakYaz(uid, platform, deger) {
    const { islem, ortam, bitis, aktif, durum } = deger;
    await d.abonelikYaz(uid, { platform, islem, ortam, bitis, aktif, durum });
    console.log(`[satinalma] ${platform} uid=${uid} islem=${islem} durum=${durum} bitis=${new Date(bitis).toISOString()} ortam=${ortam}`);
    if (!aktif) return yanit(400, { hata: 'abonelik_aktif_degil', durum, bitis });
    return null;
  }

  async function appleSatinalma(uid, govde) {
    const simdi = d.saat().getTime();
    let deger = null;
    // 1) App Store Server API (anahtar tanımlı ve istemci işlem kimliği gönderdiyse).
    if (d.appleApi && typeof govde.transactionId === 'string' && /^[0-9]{1,40}$/.test(govde.transactionId)) {
      try {
        deger = abonelikDurumunuDegerlendir(await d.appleApi(govde.transactionId), simdi);
      } catch (err) {
        console.error('[satinalma] App Store Server API erişilemedi:', err.message);
        if (typeof govde.receipt !== 'string') return yanit(502, { hata: 'apple_erisilemedi' });
      }
      if (deger && !deger.ok && typeof govde.receipt === 'string') deger = null; // makbuzla yeniden dene
    }
    // 2) verifyReceipt (APPLE_SHARED_SECRET ile).
    if (!deger) {
      let sonuc;
      try {
        sonuc = await d.apple(govde.receipt);
      } catch (err) {
        console.error('[satinalma] Apple erişilemedi:', err.message);
        return yanit(502, { hata: 'apple_erisilemedi' });
      }
      deger = makbuzuDegerlendir(sonuc, simdi);
    }
    if (!deger.ok) {
      const { ok, ...ayrinti } = deger;
      if (deger.hata === 'apple_ortak_sir_hatali') console.error('[satinalma] APPLE_SHARED_SECRET eksik ya da hatalı (21004).');
      return yanit(deger.hata === 'apple_ortak_sir_hatali' ? 503 : 400, ayrinti);
    }
    const red = await hakYaz(uid, 'ios', deger);
    if (red) return red;
    return yanit(200, { ok: true, aktif: true, bitis: deger.bitis });
  }

  async function googleSatinalma(uid, purchaseToken) {
    if (!d.google) return yanit(503, { hata: 'google_yapilandirilmadi' });
    const istek = { purchaseToken, productId: ANDROID_URUN_ID };
    let sonuc;
    try {
      sonuc = await d.google(istek);
    } catch (err) {
      console.error('[satinalma] Google Play erişilemedi:', err.message);
      return yanit(502, { hata: 'google_erisilemedi' });
    }
    const deger = googleSatinAliminiDegerlendir(sonuc, purchaseToken, d.saat().getTime());
    if (!deger.ok) {
      const { ok, durum, ...ayrinti } = deger;
      return yanit(durum, ayrinti);
    }
    const red = await hakYaz(uid, 'android', deger);
    if (red) return red;
    // Onaylanmayan ilk abonelik satın alımını Google 3 gün içinde iade eder.
    // Sunucu onaylar; olmazsa istemcinin finish() çağrısı da onaylar.
    let onaylandi = !deger.onayGerekli;
    if (deger.onayGerekli) {
      try {
        await d.googleOnayla(istek);
        onaylandi = true;
      } catch (err) {
        console.error('[satinalma] Google acknowledge başarısız:', err.message);
      }
    }
    return yanit(200, { ok: true, aktif: true, bitis: deger.bitis, onaylandi });
  }

  // --- POST /hesap/sil -------------------------------------------------------
  // Kullanıcının kendi verisini ve Auth hesabını siler. Kurallar istemcinin
  // bunları silmesine izin vermediği için iş sunucudadır. Yanlışlıkla silmeye
  // karşı oturumun yakın zamanda (şifreyle) açılmış olması gerekir.
  async function hesapSil(kim, govde) {
    if (govde?.onay !== 'SIL') return yanit(400, { hata: 'onay_gerekli' });
    const su = Math.floor(simdi().getTime() / 1000);
    if (!kim.authTime || su - kim.authTime > YENI_GIRIS_SN) {
      return yanit(401, { hata: 'yeniden_giris_gerekli' });
    }
    const kullanici = await d.kullanici(kim.uid);
    const sonuc = await d.hesabiSil(kim.uid, kullanici?.rol ?? null);
    console.log(`[hesap] silindi uid=${kim.uid} rol=${kullanici?.rol ?? '-'}`);
    return yanit(200, { ok: true, ...sonuc });
  }

  // --- POST /cron/hareketsizlik ---------------------------------------------
  async function hareketsizlik(basliklar, sorgu) {
    if (!d.cronSecret || !sirEsit(basliklar['x-cron-secret'], d.cronSecret)) {
      return yanit(401, { hata: 'yetkisiz' });
    }
    const su = simdi();
    const gun = gunTR(su);
    const zorla = sorgu.get('zorla') === '1';
    if (!zorla && !(await d.gunKilidi('hareketsizlik', gun))) {
      return yanit(200, { ok: true, atlandi: 'bugun_calisti', gun });
    }
    // Son aktifliği 3 ile 4 gün önce arasında olanlar: her hareketsizlik
    // döneminde tek hatırlatma (cron günde bir çalışır).
    const ust = new Date(su.getTime() - 3 * GUN_MS);
    const alt = new Date(su.getTime() - 4 * GUN_MS);
    const ogrenciler = await d.hareketsizOgrenciler(alt, ust);

    let gonderilen = 0;
    for (const o of ogrenciler) {
      const veri = { tur: 'hareketsizlik', ogrenciUid: o.sid };
      gonderilen += (await d.gonder([o.sid], { ...metinler.hareketsizOgrenciye(), veri })).gonderilen;
      const izleyenler = (await d.izleyiciler(o.sid)).map((b) => b.izleyiciUid);
      gonderilen += (await d.gonder(izleyenler, { ...metinler.hareketsizIzleyiciye(o.ad || 'Öğrenciniz'), veri })).gonderilen;
    }
    return yanit(200, { ok: true, gun, ogrenci: ogrenciler.length, gonderilen });
  }

  // --- yönlendirme ----------------------------------------------------------
  return async function isle({ yontem, yol, basliklar = {}, sorgu = new URLSearchParams(), govde }) {
    if (yontem === 'OPTIONS') return yanit(204, null);
    if (yol === '/saglik' && (yontem === 'GET' || yontem === 'HEAD')) {
      return yanit(200, { ok: true, zaman: simdi().toISOString() });
    }
    if (yontem !== 'POST') {
      return ['/bildir', '/satinalma/dogrula', '/hesap/sil', '/cron/hareketsizlik'].includes(yol)
        ? yanit(405, { hata: 'yontem_desteklenmiyor' })
        : yanit(404, { hata: 'bulunamadi' });
    }
    try {
      if (yol === '/cron/hareketsizlik') return await hareketsizlik(basliklar, sorgu);
      if (yol === '/bildir' || yol === '/satinalma/dogrula' || yol === '/hesap/sil') {
        const kim = await cagiran(basliklar);
        if (!kim) return yanit(401, { hata: 'kimlik_gerekli' });
        if (yol === '/hesap/sil') return await hesapSil(kim, govde);
        return yol === '/bildir' ? await bildir(kim.uid, govde) : await satinalma(kim.uid, govde);
      }
      return yanit(404, { hata: 'bulunamadi' });
    } catch (err) {
      console.error(`${yol} hata:`, err);
      return yanit(500, { hata: 'sunucu_hatasi' });
    }
  };
}
