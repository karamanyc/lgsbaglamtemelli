import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BUNDLE_ID,
  IOS_URUN_ID,
  abonelikDurumuSor,
  abonelikDurumunuDegerlendir,
  appStoreApiAyarlari,
  appStoreJwt,
  appleyaSor,
  jwsYukunuCoz,
  makbuzuDegerlendir,
} from '../src/apple.js';

const yanitla = (json, ok = true, status = 200) => ({ ok, status, json: async () => json });
const SIMDI = Date.parse('2026-09-26T17:00:00Z');
const GUN = 24 * 60 * 60 * 1000;

describe('appleyaSor (fetch taklidi)', () => {
  it('önce üretime sorar; ortak sırrı password olarak yollar', async () => {
    const f = vi.fn(async () => yanitla({ status: 0, receipt: {} }));
    const s = await appleyaSor('makbuz', 'sir', f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('https://buy.itunes.apple.com/verifyReceipt');
    const govde = JSON.parse(f.mock.calls[0][1].body);
    expect(govde['receipt-data']).toBe('makbuz');
    expect(govde.password).toBe('sir');
    expect(s.ortam).toBe('Production');
  });

  it('21007 dönerse sandbox\'a sorar', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(yanitla({ status: 21007 }))
      .mockResolvedValueOnce(yanitla({ status: 0, receipt: { bundle_id: 'x' } }));
    const s = await appleyaSor('makbuz', undefined, f);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][0]).toBe('https://sandbox.itunes.apple.com/verifyReceipt');
    expect(JSON.parse(f.mock.calls[0][1].body).password).toBeUndefined();
    expect(s.ortam).toBe('Sandbox');
  });

  it('HTTP hatası fırlatır', async () => {
    await expect(appleyaSor('makbuz', 's', vi.fn(async () => yanitla({}, false, 503)))).rejects.toThrow('503');
  });
});

describe('makbuzuDegerlendir (abonelik)', () => {
  const satir = (bitis, ekstra = {}) => ({
    product_id: IOS_URUN_ID,
    transaction_id: String(bitis),
    original_transaction_id: '1000',
    expires_date_ms: String(bitis),
    ...ekstra,
  });
  const makbuz = (satirlar, ekstra = {}) => ({
    status: 0,
    ortam: 'Production',
    receipt: { bundle_id: BUNDLE_ID, in_app: [] },
    latest_receipt_info: satirlar,
    ...ekstra,
  });

  it('en geç bitişli satırı alır; gelecekteyse aktif', () => {
    const d = makbuzuDegerlendir(makbuz([satir(SIMDI - 20 * GUN), satir(SIMDI + 10 * GUN)]), SIMDI);
    expect(d).toEqual({ ok: true, islem: '1000', bitis: SIMDI + 10 * GUN, aktif: true, durum: 'aktif', ortam: 'Production' });
  });

  it('süresi dolmuşsa aktif değil', () => {
    const d = makbuzuDegerlendir(makbuz([satir(SIMDI - GUN)]), SIMDI);
    expect(d.ok).toBe(true);
    expect(d.aktif).toBe(false);
    expect(d.durum).toBe('suresi_doldu');
  });

  it('ek süre (grace period) hak verir', () => {
    const d = makbuzuDegerlendir(
      makbuz([satir(SIMDI - GUN)], {
        pending_renewal_info: [{ product_id: IOS_URUN_ID, grace_period_expires_date_ms: String(SIMDI + 3 * GUN) }],
      }),
      SIMDI,
    );
    expect(d.aktif).toBe(true);
    expect(d.durum).toBe('ek_sure');
  });

  it('iade edilen satır, başka ürün, yanlış bundle, geçersiz durum, ortak sır hatası', () => {
    expect(makbuzuDegerlendir(makbuz([satir(SIMDI + GUN, { cancellation_date: 'x' })]), SIMDI).hata).toBe('urun_bulunamadi');
    expect(makbuzuDegerlendir(makbuz([{ ...satir(SIMDI + GUN), product_id: 'baska' }]), SIMDI).hata).toBe('urun_bulunamadi');
    expect(makbuzuDegerlendir({ ...makbuz([]), receipt: { bundle_id: 'com.baska' } }, SIMDI).hata).toBe('yanlis_uygulama');
    expect(makbuzuDegerlendir({ status: 21003 }, SIMDI).hata).toBe('makbuz_gecersiz');
    expect(makbuzuDegerlendir({ status: 21004 }, SIMDI).hata).toBe('apple_ortak_sir_hatali');
  });
});

describe('App Store Server API', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ayar = { issuerId: 'issuer-1', keyId: 'KEY123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const jws = (yuk) => `e30.${Buffer.from(JSON.stringify(yuk)).toString('base64url')}.imza`;

  it('ayarlar ortam değişkenlerinden okunur; \\n kaçışları çözülür', () => {
    expect(appStoreApiAyarlari({})).toBeNull();
    const a = appStoreApiAyarlari({ APPLE_ISSUER_ID: 'i', APPLE_KEY_ID: 'k', APPLE_PRIVATE_KEY: 'a\\nb' });
    expect(a.privateKey).toBe('a\nb');
  });

  it('ES256 JWT doğru alanlarla imzalanır', () => {
    const jwt = appStoreJwt(ayar, 1_800_000_000);
    const [b, y, imza] = jwt.split('.');
    expect(JSON.parse(Buffer.from(b, 'base64url'))).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    const yuk = JSON.parse(Buffer.from(y, 'base64url'));
    expect(yuk).toMatchObject({ iss: 'issuer-1', aud: 'appstoreconnect-v1', bid: BUNDLE_ID, iat: 1_800_000_000 });
    expect(yuk.exp - yuk.iat).toBeLessThanOrEqual(3600);
    const ok = verify('sha256', Buffer.from(`${b}.${y}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(imza, 'base64url'));
    expect(ok).toBe(true);
  });

  it('önce üretim, 404 ise sandbox', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(yanitla({}, false, 404))
      .mockResolvedValueOnce(yanitla({ bundleId: BUNDLE_ID, data: [] }));
    const s = await abonelikDurumuSor('2000', ayar, f);
    expect(f.mock.calls[0][0]).toBe('https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/2000');
    expect(f.mock.calls[1][0]).toBe('https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/2000');
    expect(f.mock.calls[0][1].headers.authorization).toMatch(/^Bearer ey/);
    expect(s).toEqual({ bulundu: true, veri: { bundleId: BUNDLE_ID, data: [] }, ortam: 'Sandbox' });
    await expect(abonelikDurumuSor('1', ayar, vi.fn(async () => yanitla({}, false, 500)))).rejects.toThrow('500');
  });

  it('durumları değerlendirir', () => {
    const sonuc = (status, islem, yenileme) => ({
      bulundu: true,
      ortam: 'Production',
      veri: {
        bundleId: BUNDLE_ID,
        data: [{ subscriptionGroupIdentifier: 'g', lastTransactions: [{ status, originalTransactionId: '1000', signedTransactionInfo: jws(islem), signedRenewalInfo: yenileme && jws(yenileme) }] }],
      },
    });
    const islem = (ekstra = {}) => ({ productId: IOS_URUN_ID, bundleId: BUNDLE_ID, originalTransactionId: '1000', expiresDate: SIMDI + 5 * GUN, environment: 'Sandbox', ...ekstra });

    expect(abonelikDurumunuDegerlendir(sonuc(1, islem()), SIMDI)).toEqual({
      ok: true, islem: '1000', bitis: SIMDI + 5 * GUN, aktif: true, durum: 'aktif', ortam: 'Sandbox',
    });
    expect(abonelikDurumunuDegerlendir(sonuc(2, islem({ expiresDate: SIMDI - GUN })), SIMDI)).toMatchObject({ aktif: false, durum: 'suresi_doldu' });
    expect(
      abonelikDurumunuDegerlendir(sonuc(4, islem({ expiresDate: SIMDI - GUN }), { gracePeriodExpiresDate: SIMDI + GUN }), SIMDI),
    ).toMatchObject({ aktif: true, durum: 'ek_sure', bitis: SIMDI + GUN });
    expect(abonelikDurumunuDegerlendir(sonuc(5, islem({ revocationDate: SIMDI })), SIMDI)).toMatchObject({ aktif: false, durum: 'iptal_iade' });
    expect(abonelikDurumunuDegerlendir(sonuc(1, islem({ productId: 'baska' })), SIMDI).hata).toBe('urun_bulunamadi');
    expect(abonelikDurumunuDegerlendir({ bulundu: false, httpDurum: 404 }, SIMDI).hata).toBe('islem_bulunamadi');
    expect(jwsYukunuCoz('bozuk')).toBeNull();
  });
});
