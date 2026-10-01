// firebase-admin ile gerçek bağımlılıklar (Firestore, FCM, ID token).

import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { abonelikDurumuSor, appStoreApiAyarlari, appleyaSor } from './apple.js';
import { fcmMesaji, kullanicilaraGonder } from './bildirim.js';
import { erisimJetonuSaglayici, googleaSor, googleOnayla, playServisHesabi } from './google.js';
import { hesabiSil } from './hesap.js';

export function servisHesabi(env) {
  const ham = env.FIREBASE_SERVICE_ACCOUNT;
  if (!ham) throw new Error('FIREBASE_SERVICE_ACCOUNT tanımlı değil');
  try {
    return JSON.parse(ham);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT geçerli JSON değil');
  }
}

export function firebaseBagimliliklari(env) {
  const sa = servisHesabi(env);
  const app = initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const db = getFirestore(app);
  const auth = getAuth(app);
  const messaging = getMessaging(app);
  const playHesabi = playServisHesabi(env);
  const playJetonu = playHesabi ? erisimJetonuSaglayici(playHesabi) : null;
  const appleApiAyar = appStoreApiAyarlari(env);
  if (!appleApiAyar && !env.APPLE_SHARED_SECRET) {
    console.warn('APPLE_SHARED_SECRET ve App Store Server API anahtarı yok: iOS abonelikleri doğrulanamaz.');
  }
  if (!playHesabi) console.warn('Google Play servis hesabı yok: Android satın alma doğrulanamaz (503).');

  const veri = async (ref) => {
    const s = await ref.get();
    return s.exists ? s.data() : null;
  };

  const gonderimBag = {
    async kullanicilariGetir(uidler) {
      const snaps = await db.getAll(...uidler.map((u) => db.doc(`users/${u}`)));
      return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
    },
    async cokluGonder(tokenlar, mesaj) {
      return messaging.sendEachForMulticast(fcmMesaji(tokenlar, mesaj));
    },
    async tokenlariSil(uid, tokenlar) {
      await db.doc(`users/${uid}`).update({ fcmTokens: FieldValue.arrayRemove(...tokenlar) });
    },
  };

  return {
    cronSecret: env.CRON_SECRET || '',

    async kimlikDogrula(token) {
      try {
        const k = await auth.verifyIdToken(token);
        return { uid: k.uid, authTime: k.auth_time };
      } catch {
        return null;
      }
    },

    kullanici: (uid) => veri(db.doc(`users/${uid}`)),
    ogrenci: (sid) => veri(db.doc(`ogrenciler/${sid}`)),
    ilerleme: (sid, konuId) => veri(db.doc(`ogrenciler/${sid}/ilerleme/${konuId}`)),

    async baglantiVar(sid, iid) {
      return (await db.doc(`baglantilar/${sid}_${iid}`).get()).exists;
    },

    async izleyiciler(sid) {
      const q = await db.collection('baglantilar').where('ogrenciUid', '==', sid).get();
      return q.docs.map((s) => ({ izleyiciUid: s.get('izleyiciUid'), rol: s.get('rol') }));
    },

    /** İlk kez görülen anahtar için true (belge oluşturma tek sefer başarılı olur). */
    async birKez(anahtar) {
      try {
        await db.doc(`bildirimKayitlari/${anahtar}`).create({ ts: FieldValue.serverTimestamp() });
        return true;
      } catch (err) {
        if (err.code === 6 /* ALREADY_EXISTS */) return false;
        throw err;
      }
    },

    async gunKilidi(is, gun) {
      try {
        await db.doc(`sunucuDurumu/${is}_${gun}`).create({ baslangic: FieldValue.serverTimestamp() });
        return true;
      } catch (err) {
        if (err.code === 6) return false;
        throw err;
      }
    },

    async hareketsizOgrenciler(alt, ust) {
      const q = await db
        .collection('ogrenciler')
        .where('sonAktif', '>=', Timestamp.fromDate(alt))
        .where('sonAktif', '<', Timestamp.fromDate(ust))
        .get();
      return q.docs.map((s) => ({ sid: s.id, ad: s.get('ad') }));
    },

    async abonelikYaz(uid, { platform, islem, ortam, bitis, aktif, durum }) {
      const batch = db.batch();
      batch.set(
        db.doc(`users/${uid}`),
        {
          abonelikBitis: Timestamp.fromMillis(bitis),
          abonelikDurum: durum,
          abonelikPlatform: platform,
          abonelikIslem: islem,
          abonelikGuncelleme: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      // Denetim kaydı: aynı mağaza aboneliğinin hangi hesaplarda kullanıldığı.
      if (islem) {
        batch.set(
          db.doc(`satinalmalar/${islem}`),
          {
            uidler: FieldValue.arrayUnion(uid),
            ortam: ortam || null,
            platform,
            bitis: Timestamp.fromMillis(bitis),
            aktif,
            durum,
            son: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      await batch.commit();
    },

    gonder: (uidler, mesaj) => kullanicilaraGonder(gonderimBag, uidler, mesaj),

    apple: (receipt) => appleyaSor(receipt, env.APPLE_SHARED_SECRET),
    appleApi: appleApiAyar ? (islemId) => abonelikDurumuSor(islemId, appleApiAyar) : undefined,

    google: playJetonu ? (istek) => googleaSor(istek, playJetonu) : undefined,
    googleOnayla: (istek) => googleOnayla(istek, playJetonu),

    hesabiSil: (uid, rol) => hesabiSil(db, auth, uid, rol),
  };
}
