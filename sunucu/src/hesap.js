// Hesap silme (POST /hesap/sil). App Store ve Google Play, kayıt olunabilen
// uygulamalarda hesabın uygulama içinden silinebilmesini ister. Firestore
// kuralları bu belgelerin istemciden silinmesine izin vermez; iş burada,
// firebase-admin ile yapılır.
//
// Silinenler:
//  - users/{uid} ve Auth kullanıcısı
//  - öğrenci: ogrenciler/{uid} ve tüm alt koleksiyonları (ilerleme, cevaplar,
//    raporlar, geribildirimler), kendi bağlantıları, bağlantı kodları,
//    bildirimKayitlari/{uid}_*
//  - veli/öğretmen: kendi bağlantıları (öğrencinin sayacı 1 azaltılır) ve
//    yazdığı geri bildirimler (collectionGroup, fieldOverride gerekir)
//  - herkes: satinalmalar/* denetim kayıtlarındaki uid (arrayRemove)

import { FieldPath, FieldValue } from 'firebase-admin/firestore';

const PARCA = 400;

async function topluSil(db, refler) {
  for (let i = 0; i < refler.length; i += PARCA) {
    const batch = db.batch();
    for (const r of refler.slice(i, i + PARCA)) batch.delete(r);
    await batch.commit();
  }
  return refler.length;
}

const sayacAlani = (rol) => (rol === 'veli' ? 'veliSayisi' : 'ogretmenSayisi');

/**
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {{ deleteUser(uid: string): Promise<void> }} auth
 */
export async function hesabiSil(db, auth, uid, rol) {
  const sayim = { baglanti: 0, kod: 0, geribildirim: 0, kayit: 0 };

  if (rol === 'ogrenci') {
    const baglantilar = await db.collection('baglantilar').where('ogrenciUid', '==', uid).get();
    sayim.baglanti = await topluSil(db, baglantilar.docs.map((s) => s.ref));

    const kodlar = await db.collection('baglantiKodlari').where('ogrenciUid', '==', uid).get();
    sayim.kod = await topluSil(db, kodlar.docs.map((s) => s.ref));

    const kayitlar = await db
      .collection('bildirimKayitlari')
      .orderBy(FieldPath.documentId())
      .startAt(`${uid}_`)
      .endAt(`${uid}_`)
      .get();
    sayim.kayit = await topluSil(db, kayitlar.docs.map((s) => s.ref));

    await db.recursiveDelete(db.doc(`ogrenciler/${uid}`));
  } else if (rol === 'veli' || rol === 'ogretmen') {
    const baglantilar = await db.collection('baglantilar').where('izleyiciUid', '==', uid).get();
    for (const b of baglantilar.docs) {
      const sid = b.get('ogrenciUid');
      const batch = db.batch();
      batch.delete(b.ref);
      const ogr = await db.doc(`users/${sid}`).get();
      if (ogr.exists) batch.update(ogr.ref, { [sayacAlani(b.get('rol'))]: FieldValue.increment(-1) });
      await batch.commit();
      sayim.baglanti += 1;
    }

    const notlar = await db.collectionGroup('geribildirimler').where('yazanUid', '==', uid).get();
    sayim.geribildirim = await topluSil(db, notlar.docs.map((s) => s.ref));
  }

  const satinalmalar = await db.collection('satinalmalar').where('uidler', 'array-contains', uid).get();
  for (const s of satinalmalar.docs) await s.ref.update({ uidler: FieldValue.arrayRemove(uid) });

  await db.doc(`users/${uid}`).delete();

  try {
    await auth.deleteUser(uid);
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') throw err;
  }
  return sayim;
}
