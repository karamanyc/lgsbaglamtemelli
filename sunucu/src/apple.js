// App Store abonelik doğrulama (otomatik yenilenen aylık abonelik).
//
// İki yol var:
//  1. App Store Server API (önerilen): GET /inApps/v1/subscriptions/{transactionId}.
//     ES256 JWT ile imzalanır; APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY
//     ortam değişkenleri gerekir (App Store Connect → Users and Access →
//     Integrations → In-App Purchase anahtarı). İstemci `transactionId` gönderirse
//     ve anahtar tanımlıysa bu yol kullanılır.
//  2. verifyReceipt (yedek): makbuz + APPLE_SHARED_SECRET (App Store Connect →
//     uygulama → App Information → App-Specific Shared Secret). Otomatik
//     yenilenen aboneliklerde ortak sır ZORUNLUDUR. Önce üretim; 21007 dönerse
//     sandbox (TestFlight, App Review).
//
// Hak (entitlement) = bitiş tarihi gelecekte olan etkin abonelik.

import { createPrivateKey, sign } from 'node:crypto';

export const BUNDLE_ID = 'com.yyapps.lgsbaglamtemelli';
/** App Store Connect: abonelik grubu "LGS Bağlam Premium", aylık abonelik. */
export const IOS_URUN_ID = 'com.yyapps.lgsbaglamtemelli.aylik';

const URETIM = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';
const API_URETIM = 'https://api.storekit.itunes.apple.com';
const API_SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

// --------------------------------------------------------------- verifyReceipt

export async function appleyaSor(receipt, ortakSir, fetchFn = fetch) {
  const istek = { 'receipt-data': receipt, 'exclude-old-transactions': true };
  if (ortakSir) istek.password = ortakSir;
  const govde = JSON.stringify(istek);
  const cagir = async (url) => {
    const yanit = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: govde,
    });
    if (!yanit.ok) throw new Error(`Apple HTTP ${yanit.status}`);
    return yanit.json();
  };
  let sonuc = await cagir(URETIM);
  let ortam = 'Production';
  if (sonuc && sonuc.status === 21007) {
    sonuc = await cagir(SANDBOX);
    ortam = 'Sandbox';
  }
  return { ...sonuc, ortam };
}

/**
 * verifyReceipt yanıtını değerlendirir.
 * { ok: true, islem, bitis (ms), aktif, durum, ortam } ya da { ok: false, hata, ... }.
 */
export function makbuzuDegerlendir(sonuc, simdiMs = Date.now()) {
  if (sonuc?.status === 21004) return { ok: false, hata: 'apple_ortak_sir_hatali', appleDurum: 21004 };
  if (!sonuc || sonuc.status !== 0) {
    return { ok: false, hata: 'makbuz_gecersiz', appleDurum: sonuc?.status ?? null };
  }
  const bilgi = sonuc.receipt || {};
  if (bilgi.bundle_id !== BUNDLE_ID) {
    return { ok: false, hata: 'yanlis_uygulama', bundleId: bilgi.bundle_id ?? null };
  }
  const satirlar = [...(sonuc.latest_receipt_info || []), ...(bilgi.in_app || [])].filter(
    (s) => s.product_id === IOS_URUN_ID && !s.cancellation_date && Number(s.expires_date_ms) > 0,
  );
  if (satirlar.length === 0) return { ok: false, hata: 'urun_bulunamadi' };
  const son = satirlar.reduce((a, b) => (Number(b.expires_date_ms) > Number(a.expires_date_ms) ? b : a));
  const sonBitis = Number(son.expires_date_ms);
  // Faturalama sorunu varken Apple'ın tanıdığı ek süre (grace period).
  const yenileme = (sonuc.pending_renewal_info || []).find((p) => p.product_id === IOS_URUN_ID);
  const ekSure = Number(yenileme?.grace_period_expires_date_ms) || 0;
  const bitis = Math.max(sonBitis, ekSure);
  const aktif = bitis > simdiMs;
  return {
    ok: true,
    islem: String(son.original_transaction_id || son.transaction_id || ''),
    bitis,
    aktif,
    durum: aktif ? (ekSure > sonBitis && sonBitis <= simdiMs ? 'ek_sure' : 'aktif') : 'suresi_doldu',
    ortam: sonuc.ortam || null,
  };
}

// --------------------------------------------------------- App Store Server API

/** Ortam değişkenlerinden App Store Server API anahtarı; eksikse null. */
export function appStoreApiAyarlari(env) {
  const issuerId = env.APPLE_ISSUER_ID;
  const keyId = env.APPLE_KEY_ID;
  const anahtar = env.APPLE_PRIVATE_KEY;
  if (!issuerId || !keyId || !anahtar) return null;
  // Render'a tek satır yapıştırıldıysa "\n" kaçışları gerçek satır sonuna çevrilir.
  return { issuerId, keyId, privateKey: anahtar.includes('\\n') ? anahtar.replace(/\\n/g, '\n') : anahtar };
}

const b64url = (x) => Buffer.from(x).toString('base64url');

/** App Store Server API için ES256 imzalı JWT (en fazla 60 dk geçerli olabilir; 20 dk kullanılır). */
export function appStoreJwt(ayar, simdiSn = Math.floor(Date.now() / 1000)) {
  const baslik = b64url(JSON.stringify({ alg: 'ES256', kid: ayar.keyId, typ: 'JWT' }));
  const yuk = b64url(
    JSON.stringify({ iss: ayar.issuerId, iat: simdiSn, exp: simdiSn + 20 * 60, aud: 'appstoreconnect-v1', bid: BUNDLE_ID }),
  );
  const imza = sign('sha256', Buffer.from(`${baslik}.${yuk}`), {
    key: createPrivateKey(ayar.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${baslik}.${yuk}.${imza.toString('base64url')}`;
}

/**
 * Get All Subscription Statuses. Önce üretim; 404 dönerse sandbox.
 * { bulundu: true, veri, ortam } ya da { bulundu: false, httpDurum }.
 */
export async function abonelikDurumuSor(transactionId, ayar, fetchFn = fetch, saat = () => Date.now()) {
  const jwt = appStoreJwt(ayar, Math.floor(saat() / 1000));
  const cagir = (taban) =>
    fetchFn(`${taban}/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
  let yanit = await cagir(API_URETIM);
  let ortam = 'Production';
  if (yanit.status === 404) {
    yanit = await cagir(API_SANDBOX);
    ortam = 'Sandbox';
  }
  if ([400, 404].includes(yanit.status)) return { bulundu: false, httpDurum: yanit.status };
  if (!yanit.ok) throw new Error(`App Store Server API HTTP ${yanit.status}`);
  return { bulundu: true, veri: await yanit.json(), ortam };
}

/**
 * JWS (signedTransactionInfo / signedRenewalInfo) yükünü çözer.
 * TODO: x5c sertifika zincirini Apple Root CA G3'e kadar doğrulamak. Yanıt
 * doğrudan Apple'dan TLS ile alındığı için şimdilik yük güvenilir sayılıyor;
 * App Store Server Notifications eklenirse imza doğrulaması ŞART olur.
 */
export function jwsYukunuCoz(jws) {
  if (typeof jws !== 'string') return null;
  const parca = jws.split('.')[1];
  if (!parca) return null;
  try {
    return JSON.parse(Buffer.from(parca, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// App Store Server API abonelik durum kodları.
const APPLE_DURUM = { 1: 'aktif', 2: 'suresi_doldu', 3: 'faturalama_sorunu', 4: 'ek_sure', 5: 'iptal_iade' };

/** Get All Subscription Statuses yanıtını değerlendirir (makbuzuDegerlendir ile aynı biçim). */
export function abonelikDurumunuDegerlendir(sonuc, simdiMs = Date.now()) {
  if (!sonuc?.bulundu) return { ok: false, hata: 'islem_bulunamadi', appleHttp: sonuc?.httpDurum ?? null };
  const v = sonuc.veri || {};
  if (v.bundleId && v.bundleId !== BUNDLE_ID) return { ok: false, hata: 'yanlis_uygulama', bundleId: v.bundleId };
  const adaylar = [];
  for (const grup of v.data || []) {
    for (const t of grup.lastTransactions || []) {
      const islem = jwsYukunuCoz(t.signedTransactionInfo);
      if (!islem || islem.productId !== IOS_URUN_ID) continue;
      if (islem.bundleId && islem.bundleId !== BUNDLE_ID) continue;
      adaylar.push({ t, islem, yenileme: jwsYukunuCoz(t.signedRenewalInfo) });
    }
  }
  if (adaylar.length === 0) return { ok: false, hata: 'urun_bulunamadi' };
  const { t, islem, yenileme } = adaylar.reduce((a, b) =>
    Number(b.islem.expiresDate) > Number(a.islem.expiresDate) ? b : a,
  );
  let bitis = Number(islem.expiresDate) || 0;
  if (t.status === 4 && Number(yenileme?.gracePeriodExpiresDate) > bitis) bitis = Number(yenileme.gracePeriodExpiresDate);
  const iptal = t.status === 5 || Boolean(islem.revocationDate);
  const aktif = !iptal && (t.status === 1 || t.status === 4) && bitis > simdiMs;
  return {
    ok: true,
    islem: String(islem.originalTransactionId || t.originalTransactionId || islem.transactionId || ''),
    bitis,
    aktif,
    durum: iptal ? 'iptal_iade' : APPLE_DURUM[t.status] || 'bilinmiyor',
    ortam: islem.environment || sonuc.ortam || null,
  };
}
