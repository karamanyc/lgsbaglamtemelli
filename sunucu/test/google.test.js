import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  erisimJetonuSaglayici,
  googleaSor,
  googleOnayla,
  googleSatinAliminiDegerlendir,
  playServisHesabi,
  ANDROID_URUN_ID,
  ANDROID_TEMEL_PLAN,
} from '../src/google.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'play@proje.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const yanitla = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });

describe('playServisHesabi', () => {
  it('önce GOOGLE_PLAY_SERVICE_ACCOUNT, yoksa FIREBASE_SERVICE_ACCOUNT', () => {
    const a = JSON.stringify({ ...sa, client_email: 'a@x' });
    const b = JSON.stringify({ ...sa, client_email: 'b@x' });
    expect(playServisHesabi({ GOOGLE_PLAY_SERVICE_ACCOUNT: a, FIREBASE_SERVICE_ACCOUNT: b }).client_email).toBe('a@x');
    expect(playServisHesabi({ FIREBASE_SERVICE_ACCOUNT: b }).client_email).toBe('b@x');
    expect(playServisHesabi({})).toBeNull();
    expect(playServisHesabi({ GOOGLE_PLAY_SERVICE_ACCOUNT: '{bozuk' })).toBeNull();
  });
});

describe('erisimJetonuSaglayici (OAuth taklidi)', () => {
  it('RS256 imzalı JWT gönderir, jetonu önbellekte tutar', async () => {
    const f = vi.fn(async () => yanitla({ access_token: 'erisim-1', expires_in: 3600 }));
    let saat = 1_800_000_000_000;
    const jeton = erisimJetonuSaglayici(sa, f, () => saat);
    expect(await jeton()).toBe('erisim-1');
    expect(await jeton()).toBe('erisim-1');
    expect(f).toHaveBeenCalledTimes(1);

    const [url, secenek] = f.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const govde = new URLSearchParams(secenek.body);
    expect(govde.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [b, i, imza] = govde.get('assertion').split('.');
    const iddia = JSON.parse(Buffer.from(i, 'base64url').toString());
    expect(iddia.iss).toBe(sa.client_email);
    expect(iddia.scope).toBe('https://www.googleapis.com/auth/androidpublisher');
    const dogrula = createVerify('RSA-SHA256');
    dogrula.update(`${b}.${i}`);
    expect(dogrula.verify(publicKey, imza, 'base64url')).toBe(true);

    saat += 3600 * 1000; // süre doldu → yeni jeton
    await jeton();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('OAuth hatası fırlatır', async () => {
    const jeton = erisimJetonuSaglayici(sa, vi.fn(async () => yanitla({}, 401)));
    await expect(jeton()).rejects.toThrow('401');
  });
});

describe('googleaSor / googleOnayla (Android Publisher taklidi)', () => {
  const istek = { purchaseToken: 'jeton/özel', productId: ANDROID_URUN_ID };
  const erisim = async () => 'erisim-1';

  it('purchases.subscriptionsv2.get doğru adrese Bearer ile gider', async () => {
    const f = vi.fn(async () => yanitla({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' }));
    const s = await googleaSor(istek, erisim, f);
    expect(s).toEqual({ bulundu: true, abonelik: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } });
    expect(f.mock.calls[0][0]).toBe(
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.yyapps.lgsbaglamtemelli' +
        '/purchases/subscriptionsv2/tokens/jeton%2F%C3%B6zel',
    );
    expect(f.mock.calls[0][1].headers.authorization).toBe('Bearer erisim-1');
  });

  it('404/410 geçersiz jeton sayılır, 5xx fırlatır', async () => {
    expect(await googleaSor(istek, erisim, vi.fn(async () => yanitla({}, 410)))).toEqual({ bulundu: false, httpDurum: 410 });
    await expect(googleaSor(istek, erisim, vi.fn(async () => yanitla({}, 503)))).rejects.toThrow('503');
  });

  it('acknowledge POST subscriptions/{ürün}/tokens/{jeton}:acknowledge', async () => {
    const f = vi.fn(async () => yanitla({}));
    await googleOnayla(istek, erisim, f);
    expect(f.mock.calls[0][0]).toMatch(/\/purchases\/subscriptions\/aylik\/tokens\/jeton%2F%C3%B6zel:acknowledge$/);
    expect(f.mock.calls[0][1].method).toBe('POST');
    await expect(googleOnayla(istek, erisim, vi.fn(async () => yanitla({}, 403)))).rejects.toThrow('403');
  });
});

describe('googleSatinAliminiDegerlendir (subscriptionsv2)', () => {
  const SIMDI = Date.parse('2026-09-26T17:00:00Z');
  const s = (x = {}, bitis = '2026-10-26T17:00:00Z') => ({
    bulundu: true,
    abonelik: {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      latestOrderId: 'GPA.9..2',
      lineItems: [{ productId: ANDROID_URUN_ID, expiryTime: bitis, offerDetails: { basePlanId: ANDROID_TEMEL_PLAN } }],
      ...x,
    },
  });

  it('etkin ve onaysız', () => {
    expect(googleSatinAliminiDegerlendir(s(), 'jeton', SIMDI)).toEqual({
      ok: true,
      islem: 'GPA.9',
      bitis: Date.parse('2026-10-26T17:00:00Z'),
      aktif: true,
      durum: 'aktif',
      ortam: 'Production',
      onayGerekli: true,
      temelPlan: 'aylik-temel',
    });
  });

  it('iptal edilmiş (yenileme kapalı) ama dönemi sürüyorsa hak verir; test satın alımı işaretlenir', () => {
    const d = googleSatinAliminiDegerlendir(
      s({ subscriptionState: 'SUBSCRIPTION_STATE_CANCELED', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', testPurchase: {} }),
      'jeton',
      SIMDI,
    );
    expect(d).toMatchObject({ aktif: true, durum: 'yenileme_kapali', ortam: 'Test', onayGerekli: false });
  });

  it('süresi dolmuş / askıda hak vermez; orderId yoksa jeton özeti', () => {
    expect(googleSatinAliminiDegerlendir(s({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }, '2026-09-01T00:00:00Z'), 'j', SIMDI).aktif).toBe(false);
    expect(googleSatinAliminiDegerlendir(s({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }), 'j', SIMDI).aktif).toBe(false);
    expect(googleSatinAliminiDegerlendir(s({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' }, '2026-09-01T00:00:00Z'), 'j', SIMDI).aktif).toBe(false);
    expect(googleSatinAliminiDegerlendir(s({ latestOrderId: undefined }), 'jeton', SIMDI).islem).toMatch(/^gp_[0-9a-f]{32}$/);
  });

  it('bekleyen, başka ürün, geçersiz jeton reddedilir', () => {
    expect(googleSatinAliminiDegerlendir(s({ subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }), 'j', SIMDI)).toMatchObject({ durum: 409, hata: 'odeme_bekliyor' });
    expect(googleSatinAliminiDegerlendir(s({ lineItems: [{ productId: 'baska', expiryTime: '2027-01-01T00:00:00Z' }] }), 'j', SIMDI).hata).toBe('urun_bulunamadi');
    expect(googleSatinAliminiDegerlendir({ bulundu: false, httpDurum: 404 }).hata).toBe('jeton_gecersiz');
  });
});
