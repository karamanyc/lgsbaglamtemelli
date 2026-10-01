// sunucu/src/hesap.js — gerçek firebase-admin ile Firestore emülatöründe.
// Auth silme taklit edilir (yalnızca Firestore emülatörü açık).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { hesabiSil } from '../src/hesap.js';

let app;
let db;
const on = `hs${Date.now().toString(36)}`;
const OGR = `${on}_ogr`;
const DIGER_OGR = `${on}_ogr2`;
const VELI = `${on}_veli`;
const OGT = `${on}_ogt`;

beforeAll(async () => {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  app = initializeApp({ projectId: 'demo-lgs-baglam' }, `hesap-silme-${on}`);
  db = getFirestore(app);
});
afterAll(async () => app && deleteApp(app));

async function kur() {
  const b = db.batch();
  const ts = Timestamp.now();
  b.set(db.doc(`users/${OGR}`), { rol: 'ogrenci', ad: 'Elif', veliSayisi: 1, ogretmenSayisi: 1 });
  b.set(db.doc(`users/${DIGER_OGR}`), { rol: 'ogrenci', ad: 'Ali', veliSayisi: 1 });
  b.set(db.doc(`users/${VELI}`), { rol: 'veli', ad: 'Ayşe' });
  b.set(db.doc(`users/${OGT}`), { rol: 'ogretmen', ad: 'Murat' });
  b.set(db.doc(`ogrenciler/${OGR}`), { ad: 'Elif', sonAktif: ts });
  b.set(db.doc(`ogrenciler/${OGR}/ilerleme/carpanlar-katlar`), { basamak: 'orta' });
  b.set(db.doc(`ogrenciler/${OGR}/cevaplar/c1`), { konuId: 'carpanlar-katlar', dogru: false, ts });
  b.set(db.doc(`ogrenciler/${OGR}/raporlar/carpanlar-katlar`), { konuId: 'carpanlar-katlar' });
  b.set(db.doc(`ogrenciler/${OGR}/geribildirimler/g1`), { yazanUid: OGT, metin: 'Aferin' });
  b.set(db.doc(`ogrenciler/${DIGER_OGR}`), { ad: 'Ali', sonAktif: ts });
  b.set(db.doc(`ogrenciler/${DIGER_OGR}/geribildirimler/g2`), { yazanUid: VELI, metin: 'Devam' });
  b.set(db.doc(`ogrenciler/${DIGER_OGR}/geribildirimler/g3`), { yazanUid: `${on}_baska`, metin: 'Kalır' });
  b.set(db.doc(`baglantilar/${OGR}_${VELI}`), { ogrenciUid: OGR, izleyiciUid: VELI, rol: 'veli' });
  b.set(db.doc(`baglantilar/${OGR}_${OGT}`), { ogrenciUid: OGR, izleyiciUid: OGT, rol: 'ogretmen' });
  b.set(db.doc(`baglantilar/${DIGER_OGR}_${VELI}`), { ogrenciUid: DIGER_OGR, izleyiciUid: VELI, rol: 'veli' });
  b.set(db.doc('baglantiKodlari/123456'), { ogrenciUid: OGR, kullanildi: false });
  b.set(db.doc(`bildirimKayitlari/${OGR}_konuBitti_carpanlar-katlar`), { ts });
  b.set(db.doc(`bildirimKayitlari/${DIGER_OGR}_konuBitti_carpanlar-katlar`), { ts });
  b.set(db.doc(`satinalmalar/${on}-GPA.1`), { uidler: [OGR, DIGER_OGR] });
  await b.commit();
}

const var_ = async (yol) => (await db.doc(yol).get()).exists;

describe('hesabiSil', () => {
  it('öğrenci: kendi verisi, bağlantıları, kodları, bildirim kayıtları ve Auth kullanıcısı silinir', async () => {
    await kur();
    const auth = { deleteUser: vi.fn(async () => {}) };
    const sayim = await hesabiSil(db, auth, OGR, 'ogrenci');

    expect(sayim).toMatchObject({ baglanti: 2, kod: 1, kayit: 1 });
    expect(auth.deleteUser).toHaveBeenCalledWith(OGR);
    for (const yol of [
      `users/${OGR}`,
      `ogrenciler/${OGR}`,
      `ogrenciler/${OGR}/ilerleme/carpanlar-katlar`,
      `ogrenciler/${OGR}/cevaplar/c1`,
      `ogrenciler/${OGR}/raporlar/carpanlar-katlar`,
      `ogrenciler/${OGR}/geribildirimler/g1`,
      `baglantilar/${OGR}_${VELI}`,
      `baglantilar/${OGR}_${OGT}`,
      'baglantiKodlari/123456',
      `bildirimKayitlari/${OGR}_konuBitti_carpanlar-katlar`,
    ]) {
      expect(await var_(yol), yol).toBe(false);
    }
    // Başkalarının verisi yerinde.
    expect(await var_(`users/${VELI}`)).toBe(true);
    expect(await var_(`baglantilar/${DIGER_OGR}_${VELI}`)).toBe(true);
    expect(await var_(`bildirimKayitlari/${DIGER_OGR}_konuBitti_carpanlar-katlar`)).toBe(true);
    expect((await db.doc(`satinalmalar/${on}-GPA.1`).get()).get('uidler')).toEqual([DIGER_OGR]);
  });

  it('veli: bağlantıları kopar (öğrenci sayacı azalır), yazdığı notlar silinir', async () => {
    await kur();
    const auth = { deleteUser: vi.fn(async () => {}) };
    const sayim = await hesabiSil(db, auth, VELI, 'veli');

    expect(sayim).toMatchObject({ baglanti: 2, geribildirim: 1 });
    expect(await var_(`users/${VELI}`)).toBe(false);
    expect(await var_(`baglantilar/${DIGER_OGR}_${VELI}`)).toBe(false);
    expect(await var_(`ogrenciler/${DIGER_OGR}/geribildirimler/g2`)).toBe(false);
    expect(await var_(`ogrenciler/${DIGER_OGR}/geribildirimler/g3`)).toBe(true);
    expect((await db.doc(`users/${DIGER_OGR}`).get()).get('veliSayisi')).toBe(0);
    // İki bağlı öğrencinin de veli sayacı 1 azaldı.
    expect((await db.doc(`users/${OGR}`).get()).get('veliSayisi')).toBe(0);
    expect(auth.deleteUser).toHaveBeenCalledWith(VELI);
  });

  it('Auth kullanıcısı zaten yoksa hata vermez; başka Auth hatası yukarı çıkar', async () => {
    const yok = { deleteUser: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'auth/user-not-found' }))) };
    await expect(hesabiSil(db, yok, `${on}_hic`, null)).resolves.toBeDefined();
    const bozuk = { deleteUser: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'auth/internal-error' }))) };
    await expect(hesabiSil(db, bozuk, `${on}_hic2`, null)).rejects.toThrow();
  });
});
