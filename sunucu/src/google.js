// Google Play abonelik doğrulama (Android Publisher API v3,
// purchases.subscriptionsv2.get + purchases.subscriptions.acknowledge). Kimlik: Play Console'da yetki verilmiş
// bir Google Cloud servis hesabı. JSON ortam değişkeninden okunur
// (GOOGLE_PLAY_SERVICE_ACCOUNT; yoksa FIREBASE_SERVICE_ACCOUNT). Bağımlılık yok:
// JWT node:crypto ile imzalanır ve OAuth erişim jetonuna çevrilir.

import { createHash, createSign } from 'node:crypto';
import { BUNDLE_ID } from './apple.js';

/** Play Console → Monetize → Subscriptions: ürün kimliği ve aylık temel plan. */
export const ANDROID_URUN_ID = 'aylik';
export const ANDROID_TEMEL_PLAN = 'aylik-temel';

export const PAKET_ADI = BUNDLE_ID;
const KAPSAM = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

const b64url = (x) => Buffer.from(x).toString('base64url');

export function playServisHesabi(env) {
  const ham = env.GOOGLE_PLAY_SERVICE_ACCOUNT || env.FIREBASE_SERVICE_ACCOUNT;
  if (!ham) return null;
  try {
    const sa = JSON.parse(ham);
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

/** Servis hesabıyla imzalı JWT → OAuth erişim jetonu (süresine kadar önbellekte). */
export function erisimJetonuSaglayici(sa, fetchFn = fetch, saat = () => Date.now()) {
  let onbellek = null;
  return async function erisimJetonu() {
    const simdi = Math.floor(saat() / 1000);
    if (onbellek && onbellek.bitis - 60 > simdi) return onbellek.jeton;
    const baslik = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const iddia = b64url(
      JSON.stringify({ iss: sa.client_email, scope: KAPSAM, aud: TOKEN_URL, iat: simdi, exp: simdi + 3600 }),
    );
    const imzalayan = createSign('RSA-SHA256');
    imzalayan.update(`${baslik}.${iddia}`);
    const jwt = `${baslik}.${iddia}.${imzalayan.sign(sa.private_key, 'base64url')}`;
    const yanit = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
    });
    if (!yanit.ok) throw new Error(`Google OAuth HTTP ${yanit.status}`);
    const j = await yanit.json();
    onbellek = { jeton: j.access_token, bitis: simdi + (Number(j.expires_in) || 3600) };
    return onbellek.jeton;
  };
}

const tabanYol = () => `${API}/${encodeURIComponent(PAKET_ADI)}/purchases`;

/**
 * purchases.subscriptionsv2.get. Dönüş: { bulundu: true, abonelik } ya da
 * { bulundu: false, httpDurum } (400/404/410: jeton geçersiz). Diğer HTTP
 * hataları fırlatılır (502'ye çevrilir).
 */
export async function googleaSor({ purchaseToken }, erisimJetonu, fetchFn = fetch) {
  const jeton = await erisimJetonu();
  const yanit = await fetchFn(`${tabanYol()}/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`, {
    headers: { authorization: `Bearer ${jeton}` },
  });
  if ([400, 404, 410].includes(yanit.status)) return { bulundu: false, httpDurum: yanit.status };
  if (!yanit.ok) throw new Error(`Google Play HTTP ${yanit.status}`);
  return { bulundu: true, abonelik: await yanit.json() };
}

/** purchases.subscriptions.acknowledge (tekrar çağrılırsa zarar vermez). */
export async function googleOnayla({ purchaseToken, productId }, erisimJetonu, fetchFn = fetch) {
  const jeton = await erisimJetonu();
  const yol = `${tabanYol()}/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  const yanit = await fetchFn(yol, {
    method: 'POST',
    headers: { authorization: `Bearer ${jeton}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!yanit.ok) throw new Error(`Google Play acknowledge HTTP ${yanit.status}`);
}

// Bitiş tarihine kadar hak veren durumlar. CANCELED: yenileme kapatıldı ama
// ödenmiş dönem sürüyor. ON_HOLD / PAUSED / EXPIRED hak vermez.
const HAK_VEREN = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED']);
const DURUM_ADI = {
  SUBSCRIPTION_STATE_ACTIVE: 'aktif',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'ek_sure',
  SUBSCRIPTION_STATE_CANCELED: 'yenileme_kapali',
  SUBSCRIPTION_STATE_ON_HOLD: 'askida',
  SUBSCRIPTION_STATE_PAUSED: 'duraklatildi',
  SUBSCRIPTION_STATE_EXPIRED: 'suresi_doldu',
};

/**
 * subscriptionsv2 yanıtını değerlendirir.
 * { ok: true, islem, bitis (ms), aktif, durum, ortam, onayGerekli, temelPlan }
 * ya da { ok: false, durum (HTTP), hata }.
 */
export function googleSatinAliminiDegerlendir(sonuc, purchaseToken = '', simdiMs = Date.now()) {
  if (!sonuc?.bulundu) return { ok: false, durum: 400, hata: 'jeton_gecersiz', googleDurum: sonuc?.httpDurum ?? null };
  const a = sonuc.abonelik || {};
  if (a.subscriptionState === 'SUBSCRIPTION_STATE_PENDING') return { ok: false, durum: 409, hata: 'odeme_bekliyor' };
  const satir = (a.lineItems || []).find((l) => l.productId === ANDROID_URUN_ID);
  if (!satir) return { ok: false, durum: 400, hata: 'urun_bulunamadi' };
  const bitis = Date.parse(satir.expiryTime || '') || 0;
  const aktif = HAK_VEREN.has(a.subscriptionState) && bitis > simdiMs;
  // Yenilemelerde orderId "GPA.x..0", "GPA.x..1" diye ilerler; kök kimlik saklanır.
  const kok = String(a.latestOrderId || '').replace(/\.\.\d+$/, '');
  return {
    ok: true,
    islem: kok || `gp_${createHash('sha256').update(purchaseToken).digest('hex').slice(0, 32)}`,
    bitis,
    aktif,
    durum: DURUM_ADI[a.subscriptionState] || 'bilinmiyor',
    ortam: a.testPurchase ? 'Test' : 'Production',
    onayGerekli: a.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    temelPlan: satir.offerDetails?.basePlanId ?? null,
  };
}
