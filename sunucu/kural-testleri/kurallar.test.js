// Firestore kural testleri — emülatörde çalışır (`npm test`).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

const kok = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let env;

const OGR = 'ogrenci1';
const OGR2 = 'ogrenci2';
const VELI1 = 'veli1';
const VELI2 = 'veli2';
const VELI3 = 'veli3';
const OGT = ['ogt1', 'ogt2', 'ogt3', 'ogt4'];
const YABANCI = 'yabanci';

const db = (uid) => env.authenticatedContext(uid).firestore();
const sonra = (dk) => Timestamp.fromMillis(Date.now() + dk * 60_000);

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-lgs-baglam',
    firestore: { rules: readFileSync(resolve(kok, 'firestore.rules'), 'utf8'), host, port: Number(port) },
  });
});
afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    const kul = (uid, rol, ekstra = {}) =>
      setDoc(doc(a, 'users', uid), { rol, ad: uid, olusturma: Timestamp.now(), fcmTokens: [], ...ekstra });
    await kul(OGR, 'ogrenci');
    await kul(OGR2, 'ogrenci', { abonelikBitis: sonra(60 * 24 * 30) }); // eski abonelik alanı (artık etkisiz)
    await kul(VELI1, 'veli');
    await kul(VELI2, 'veli');
    await kul(VELI3, 'veli');
    for (const o of OGT) await kul(o, 'ogretmen');
    await kul(YABANCI, 'veli');
    await setDoc(doc(a, 'ogrenciler', OGR), { ad: 'Elif', sonAktif: Timestamp.now() });
  });
});

/** Öğrenci kodu (kurallar kapalıyken) — bağlanma testleri için. */
async function kodYaz(kod, ekstra = {}) {
  await env.withSecurityRulesDisabled((ctx) =>
    setDoc(doc(ctx.firestore(), 'baglantiKodlari', kod), {
      ogrenciUid: OGR,
      sonKullanma: sonra(30),
      kullanildi: false,
      ...ekstra,
    }),
  );
}

/** İstemcinin yapması gereken bağlanma işlemi (README'deki biçim). */
async function baglan(izleyici, kod, { sayacYaz = true, kodKapat = true, ogrenciUid } = {}) {
  const f = db(izleyici);
  const rol = izleyici.startsWith('veli') || izleyici === YABANCI ? 'veli' : 'ogretmen';
  return runTransaction(f, async (tx) => {
    const kodSnap = await tx.get(doc(f, 'baglantiKodlari', kod));
    const sid = ogrenciUid || kodSnap.data().ogrenciUid;
    if (kodKapat) tx.update(doc(f, 'baglantiKodlari', kod), { kullanildi: true, kullananUid: izleyici });
    tx.set(doc(f, 'baglantilar', `${sid}_${izleyici}`), {
      ogrenciUid: sid,
      izleyiciUid: izleyici,
      rol,
      kod,
      olusturma: serverTimestamp(),
    });
    if (sayacYaz) {
      tx.update(doc(f, 'users', sid), {
        [rol === 'veli' ? 'veliSayisi' : 'ogretmenSayisi']: increment(1),
      });
    }
  });
}

async function hazirBaglanti(izleyici, sid = OGR, rol = 'veli') {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await setDoc(doc(a, 'baglantilar', `${sid}_${izleyici}`), {
      ogrenciUid: sid, izleyiciUid: izleyici, rol, kod: '000000', olusturma: Timestamp.now(),
    });
    await updateDoc(doc(a, 'users', sid), { [rol === 'veli' ? 'veliSayisi' : 'ogretmenSayisi']: increment(1) });
  });
}

describe('users', () => {
  it('kullanıcı kendi belgesini oluşturur; abonelik ve ücretsiz sayaç yazamaz', async () => {
    const f = db('yeni');
    await assertFails(setDoc(doc(f, 'users', 'yeni'), { rol: 'ogrenci', ad: 'A', olusturma: serverTimestamp(), tamPaket: true }));
    await assertFails(setDoc(doc(f, 'users', 'yeni'), { rol: 'ogrenci', ad: 'A', abonelikBitis: sonra(99999) }));
    await assertFails(setDoc(doc(f, 'users', 'yeni'), { rol: 'ogrenci', ad: 'A', ucretsizSoru: -5 }));
    await assertFails(setDoc(doc(f, 'users', 'yeni'), { rol: 'ogrenci', ad: 'A', ucretsizSoru: 2 }));
    await assertFails(setDoc(doc(f, 'users', 'yeni'), { rol: 'admin', ad: 'A', olusturma: serverTimestamp() }));
    await assertFails(setDoc(doc(f, 'users', 'yeni'), { rol: 'ogrenci', ad: 'A', veliSayisi: -3 }));
    await assertSucceeds(setDoc(doc(f, 'users', 'yeni'), { rol: 'ogrenci', ad: 'A', olusturma: serverTimestamp(), fcmTokens: [] }));
  });

  it('yeni belge ucretsizSoru 0 ya da 1 ile oluşturulabilir', async () => {
    await assertSucceeds(setDoc(doc(db('yeni0'), 'users', 'yeni0'), { rol: 'ogrenci', ad: 'A', ucretsizSoru: 0 }));
    await assertSucceeds(setDoc(doc(db('yeni1'), 'users', 'yeni1'), { rol: 'ogrenci', ad: 'A', ucretsizSoru: 1 }));
  });

  it('başkasının belgesini oluşturamaz', async () => {
    await assertFails(setDoc(doc(db('x'), 'users', 'y'), { rol: 'ogrenci', ad: 'A' }));
  });

  it('istemci abonelik, rol ve sayaçları güncelleyemez; ad ve fcmTokens güncelleyebilir', async () => {
    const f = db(OGR);
    await assertFails(updateDoc(doc(f, 'users', OGR), { tamPaket: true }));
    await assertFails(updateDoc(doc(f, 'users', OGR), { abonelikBitis: sonra(99999) }));
    await assertFails(updateDoc(doc(db(OGR2), 'users', OGR2), { abonelikBitis: sonra(-1) }));
    await assertFails(updateDoc(doc(f, 'users', OGR), { rol: 'veli' }));
    await assertFails(updateDoc(doc(f, 'users', OGR), { veliSayisi: 0 }));
    await assertFails(updateDoc(doc(db(OGR2), 'users', OGR2), { tamPaket: false }));
    await assertSucceeds(updateDoc(doc(f, 'users', OGR), { ad: 'Elif', fcmTokens: ['t1'] }));
  });

  it('okuma: kendisi ve bağlı izleyici; yabancı okuyamaz', async () => {
    await hazirBaglanti(VELI1);
    await assertSucceeds(getDoc(doc(db(OGR), 'users', OGR)));
    await assertSucceeds(getDoc(doc(db(VELI1), 'users', OGR)));
    await assertFails(getDoc(doc(db(YABANCI), 'users', OGR)));
    await assertFails(getDocs(collection(db(OGR), 'users')));
  });
});

describe('bağlantı kodu', () => {
  it('öğrenci 6 haneli, 30 dk geçerli kod üretir', async () => {
    const f = db(OGR);
    const temel = { ogrenciUid: OGR, sonKullanma: sonra(30), kullanildi: false, olusturma: serverTimestamp() };
    await assertSucceeds(setDoc(doc(f, 'baglantiKodlari', '123456'), temel));
    await assertFails(setDoc(doc(f, 'baglantiKodlari', '12345'), temel));
    await assertFails(setDoc(doc(f, 'baglantiKodlari', 'abcdef'), temel));
    await assertFails(setDoc(doc(f, 'baglantiKodlari', '223456'), { ...temel, sonKullanma: sonra(120) }));
    await assertFails(setDoc(doc(f, 'baglantiKodlari', '323456'), { ...temel, kullanildi: true }));
    await assertFails(setDoc(doc(f, 'baglantiKodlari', '423456'), { ...temel, ogrenciUid: OGR2 }));
  });

  it('veli kod üretemez; var olan kodun üzerine yazılamaz', async () => {
    const temel = { ogrenciUid: VELI1, sonKullanma: sonra(30), kullanildi: false };
    await assertFails(setDoc(doc(db(VELI1), 'baglantiKodlari', '111111'), temel));
    await kodYaz('222222');
    await assertFails(setDoc(doc(db(OGR), 'baglantiKodlari', '222222'), { ogrenciUid: OGR, sonKullanma: sonra(30), kullanildi: false }));
  });

  it('öğrenci kendi kodlarını listeler ve siler, başkası listeleyemez', async () => {
    await kodYaz('555555');
    await assertSucceeds(getDocs(query(collection(db(OGR), 'baglantiKodlari'), where('ogrenciUid', '==', OGR))));
    await assertFails(getDocs(collection(db(VELI1), 'baglantiKodlari')));
    await assertFails(deleteDoc(doc(db(VELI1), 'baglantiKodlari', '555555')));
    await assertSucceeds(deleteDoc(doc(db(OGR), 'baglantiKodlari', '555555')));
  });
});

describe('bağlanma işlemi', () => {
  it('geçerli kodla veli bağlanır; kod kullanıldı olur, sayaç 1 artar', async () => {
    await kodYaz('111111');
    await assertSucceeds(baglan(VELI1, '111111'));
    await env.withSecurityRulesDisabled(async (ctx) => {
      const a = ctx.firestore();
      expect((await getDoc(doc(a, 'baglantiKodlari', '111111'))).data().kullanildi).toBe(true);
      expect((await getDoc(doc(a, 'users', OGR))).data().veliSayisi).toBe(1);
      expect((await getDoc(doc(a, 'baglantilar', `${OGR}_${VELI1}`))).exists()).toBe(true);
    });
  });

  it('kod tek kullanımlıktır', async () => {
    await kodYaz('111111');
    await assertSucceeds(baglan(VELI1, '111111'));
    await assertFails(baglan(VELI2, '111111'));
  });

  it('süresi geçmiş kod reddedilir', async () => {
    await kodYaz('111111', { sonKullanma: sonra(-1) });
    await assertFails(baglan(VELI1, '111111'));
  });

  it('kodu kapatmadan bağlantı kurulamaz', async () => {
    await kodYaz('111111');
    await assertFails(baglan(VELI1, '111111', { kodKapat: false }));
  });

  it('sayaç artırılmadan bağlantı kurulamaz', async () => {
    await kodYaz('111111');
    await assertFails(baglan(VELI1, '111111', { sayacYaz: false }));
  });

  it('koddaki öğrenciden başka öğrenciye bağlanılamaz', async () => {
    await kodYaz('111111');
    await assertFails(baglan(VELI1, '111111', { ogrenciUid: OGR2 }));
  });

  it('kodsuz doğrudan bağlantı yazılamaz', async () => {
    const f = db(VELI1);
    const b = writeBatch(f);
    b.set(doc(f, 'baglantilar', `${OGR}_${VELI1}`), { ogrenciUid: OGR, izleyiciUid: VELI1, rol: 'veli', kod: '999999', olusturma: serverTimestamp() });
    b.update(doc(f, 'users', OGR), { veliSayisi: increment(1) });
    await assertFails(b.commit());
  });

  it('rol yalan söylenemez (veli öğretmen gibi bağlanamaz)', async () => {
    await kodYaz('111111');
    const f = db(VELI1);
    await assertFails(runTransaction(f, async (tx) => {
      await tx.get(doc(f, 'baglantiKodlari', '111111'));
      tx.update(doc(f, 'baglantiKodlari', '111111'), { kullanildi: true });
      tx.set(doc(f, 'baglantilar', `${OGR}_${VELI1}`), { ogrenciUid: OGR, izleyiciUid: VELI1, rol: 'ogretmen', kod: '111111', olusturma: serverTimestamp() });
      tx.update(doc(f, 'users', OGR), { ogretmenSayisi: increment(1) });
    }));
  });

  it('en fazla 2 veli', async () => {
    for (const [i, v] of [VELI1, VELI2, VELI3].entries()) {
      await kodYaz(`10000${i}`);
    }
    await assertSucceeds(baglan(VELI1, '100000'));
    await assertSucceeds(baglan(VELI2, '100001'));
    await assertFails(baglan(VELI3, '100002'));
  });

  it('en fazla 3 öğretmen', async () => {
    for (let i = 0; i < 4; i++) await kodYaz(`20000${i}`);
    await assertSucceeds(baglan(OGT[0], '200000'));
    await assertSucceeds(baglan(OGT[1], '200001'));
    await assertSucceeds(baglan(OGT[2], '200002'));
    await assertFails(baglan(OGT[3], '200003'));
  });

  it('bağlı olmayan izleyici, kendi kimliğini içeren bağlantı belgesini sorgulayabilir', async () => {
    await assertSucceeds(getDoc(doc(db(VELI1), 'baglantilar', `${OGR}_${VELI1}`)));
    await assertFails(getDoc(doc(db(VELI1), 'baglantilar', `${OGR}_${VELI2}`)));
  });

  it('izleyici ve öğrenci kendi bağlantılarını listeler', async () => {
    await hazirBaglanti(VELI1);
    await assertSucceeds(getDocs(query(collection(db(VELI1), 'baglantilar'), where('izleyiciUid', '==', VELI1))));
    await assertSucceeds(getDocs(query(collection(db(OGR), 'baglantilar'), where('ogrenciUid', '==', OGR))));
    await assertFails(getDocs(query(collection(db(YABANCI), 'baglantilar'), where('ogrenciUid', '==', OGR))));
  });

  it('koparma: sayaç 1 azalarak izleyici veya öğrenci koparabilir', async () => {
    await hazirBaglanti(VELI1);
    await hazirBaglanti(VELI2);
    // sayaç azaltılmadan olmaz
    await assertFails(deleteDoc(doc(db(VELI1), 'baglantilar', `${OGR}_${VELI1}`)));
    let f = db(VELI1);
    let b = writeBatch(f);
    b.delete(doc(f, 'baglantilar', `${OGR}_${VELI1}`));
    b.update(doc(f, 'users', OGR), { veliSayisi: increment(-1) });
    await assertSucceeds(b.commit());

    f = db(OGR);
    b = writeBatch(f);
    b.delete(doc(f, 'baglantilar', `${OGR}_${VELI2}`));
    b.update(doc(f, 'users', OGR), { veliSayisi: increment(-1), sonKaldirilan: VELI2 });
    await assertSucceeds(b.commit());

    // öğrenci bağlantı silmeden sayacı düşüremez
    await assertFails(updateDoc(doc(db(OGR), 'users', OGR), { veliSayisi: increment(-1), sonKaldirilan: VELI3 }));
  });
});

describe('ücretsiz soru sayacı (users.ucretsizSoru)', () => {
  const sayac = (n) =>
    env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users', OGR), { ucretsizSoru: n }));

  it('yalnızca +1 artar, 10\'u geçemez, azaltılamaz/sıfırlanamaz', async () => {
    const r = doc(db(OGR), 'users', OGR);
    await assertSucceeds(updateDoc(r, { ucretsizSoru: increment(1) }));
    await assertFails(updateDoc(r, { ucretsizSoru: increment(2) }));
    await assertFails(updateDoc(r, { ucretsizSoru: 0 }));
    await assertFails(updateDoc(r, { ucretsizSoru: increment(-1) }));
    await assertFails(updateDoc(r, { ucretsizSoru: increment(1), ad: 'Başka' }));
    await sayac(10);
    await assertFails(updateDoc(r, { ucretsizSoru: increment(1) }));
    // başkası artıramaz
    await hazirBaglanti(VELI1);
    await assertFails(updateDoc(doc(db(VELI1), 'users', OGR), { ucretsizSoru: 10 }));
  });
});

describe('öğrenci verisi (premium kapısı istemcide, RevenueCat)', () => {
  const cevap = (ekstra = {}) => ({
    konuId: 'carpanlar-katlar', soruId: '01-q1', aile: 'q1', seviye: 'orta', secilen: 'B',
    dogru: false, deneme: 1, hataTuru: 'islem', acele: false, sureMs: 23000, ts: serverTimestamp(), ...ekstra,
  });

  /** İstemcinin ücretsiz hakla yaptığı yazım: cevap + sayaç +1, tek batch. */
  const ucretsizCevap = (ekstra = {}) => {
    const f = db(OGR);
    const b = writeBatch(f);
    b.set(doc(collection(f, 'ogrenciler', OGR, 'cevaplar')), cevap(ekstra));
    b.update(doc(f, 'users', OGR), { ucretsizSoru: increment(1) });
    return b.commit();
  };

  it('ücretsiz yol: ilk deneme cevabı sayaç artışıyla yazılır; sayaç 10\'da iken artışlı yazım reddedilir', async () => {
    const c = collection(db(OGR), 'ogrenciler', OGR, 'cevaplar');
    await assertSucceeds(ucretsizCevap({ konuId: 'uslu-ifadeler' })); // konu kilidi yok
    await assertSucceeds(addDoc(c, cevap({ deneme: 2 })));
    for (let i = 2; i <= 10; i++) await assertSucceeds(ucretsizCevap());
    await assertFails(ucretsizCevap()); // 11. soru: sayaç 10'u geçemez
    await assertSucceeds(addDoc(c, cevap({ deneme: 2 }))); // 10. sorunun ikinci denemesi
    await assertSucceeds(setDoc(doc(db(OGR), 'ogrenciler', OGR, 'ilerleme', 'uslu-ifadeler'), { basamak: 'basit', basamaklar: {}, siradakiIndeks: 0, baslangic: serverTimestamp() }));
  });

  it('premium yol: sayaçsız yazım kurallarca serbest (premium RevenueCat ile istemcide denetlenir)', async () => {
    await assertSucceeds(addDoc(collection(db(OGR2), 'ogrenciler', OGR2, 'cevaplar'), cevap({ konuId: 'uslu-ifadeler' })));
    await assertSucceeds(setDoc(doc(db(OGR2), 'ogrenciler', OGR2, 'ilerleme', 'uslu-ifadeler'), { basamak: 'orta' }));
    await assertSucceeds(setDoc(doc(db(OGR2), 'ogrenciler', OGR2, 'raporlar', 'uslu-ifadeler'), { konuId: 'uslu-ifadeler', toplamSureMs: 1000 }));
    // Eski abonelikBitis alanı artık hiçbir şey belirlemez.
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users', OGR2), { abonelikBitis: sonra(-1) }));
    await assertSucceeds(addDoc(collection(db(OGR2), 'ogrenciler', OGR2, 'cevaplar'), cevap()));
    // Sayaç 10'da olsa da sayaçsız yazım kurallarca engellenmez.
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users', OGR), { ucretsizSoru: 10 }));
    await assertSucceeds(addDoc(collection(db(OGR), 'ogrenciler', OGR, 'cevaplar'), cevap()));
    await assertFails(addDoc(collection(db(OGR), 'ogrenciler', OGR, 'cevaplar'), cevap({ deneme: 3 })));
  });

  it('cevap alan/tip doğrulaması', async () => {
    const c = collection(db(OGR2), 'ogrenciler', OGR2, 'cevaplar');
    await assertSucceeds(addDoc(c, cevap({ dogru: true, hataTuru: null })));
    await assertFails(addDoc(c, cevap({ deneme: 3 })));
    await assertFails(addDoc(c, cevap({ secilen: 'E' })));
    await assertFails(addDoc(c, cevap({ hataTuru: 'baska' })));
    await assertFails(addDoc(c, cevap({ sureMs: -1 })));
    await assertFails(addDoc(c, cevap({ sureMs: '100' })));
    await assertFails(addDoc(c, cevap({ dogru: 'evet' })));
    await assertFails(addDoc(c, cevap({ seviye: 'cokzor' })));
    await assertFails(addDoc(c, cevap({ konuId: 'yok' })));
    await assertFails(addDoc(c, cevap({ fazla: 1 })));
    const { acele, ...eksik } = cevap();
    await assertFails(addDoc(c, eksik));
  });

  it('cevaplar değiştirilemez; başkası yazamaz', async () => {
    const c = collection(db(OGR2), 'ogrenciler', OGR2, 'cevaplar');
    const ref = await addDoc(c, cevap());
    await assertFails(updateDoc(ref, { dogru: true }));
    await assertFails(deleteDoc(ref));
    await hazirBaglanti(VELI1, OGR2);
    await assertFails(addDoc(collection(db(VELI1), 'ogrenciler', OGR2, 'cevaplar'), cevap()));
  });

  it('bağlı izleyici okur, yabancı okuyamaz', async () => {
    await hazirBaglanti(VELI1);
    await assertSucceeds(getDocs(collection(db(VELI1), 'ogrenciler', OGR, 'cevaplar')));
    await assertSucceeds(getDoc(doc(db(VELI1), 'ogrenciler', OGR)));
    await assertFails(getDocs(collection(db(YABANCI), 'ogrenciler', OGR, 'cevaplar')));
    await assertFails(getDoc(doc(db(YABANCI), 'ogrenciler', OGR, 'ilerleme', 'carpanlar-katlar')));
  });

  it('ogrenciler belgesi yalnızca ad ve sonAktif (Timestamp) taşır', async () => {
    const f = db(OGR);
    await assertSucceeds(setDoc(doc(f, 'ogrenciler', OGR), { ad: 'Elif', sonAktif: serverTimestamp() }));
    await assertFails(setDoc(doc(f, 'ogrenciler', OGR), { ad: 'Elif', sonAktif: Date.now() }));
    await assertFails(setDoc(doc(f, 'ogrenciler', OGR), { ad: 'Elif', tamPaket: true }));
    await assertFails(setDoc(doc(db(VELI1), 'ogrenciler', VELI1), { ad: 'Veli' }));
  });

  it('ilerleme basamak doğrulaması', async () => {
    await assertFails(setDoc(doc(db(OGR), 'ogrenciler', OGR, 'ilerleme', 'carpanlar-katlar'), { basamak: 'uzman' }));
    await assertFails(setDoc(doc(db(OGR), 'ogrenciler', OGR, 'ilerleme', 'carpanlar-katlar'), { basamak: 'basit', fazla: 1 }));
  });
});

describe('geri bildirim', () => {
  const gb = (uid, rol = 'veli', ekstra = {}) => ({
    yazanUid: uid, yazanRol: rol, yazanAd: 'Ayşe Hanım', metin: 'Harika gidiyorsun!', ts: serverTimestamp(), okundu: false, ...ekstra,
  });

  it('yalnızca bağlı izleyici yazar', async () => {
    await hazirBaglanti(VELI1);
    const yol = (f) => collection(f, 'ogrenciler', OGR, 'geribildirimler');
    await assertSucceeds(addDoc(yol(db(VELI1)), gb(VELI1, 'veli', { konuId: 'carpanlar-katlar' })));
    await assertFails(addDoc(yol(db(YABANCI)), gb(YABANCI)));
    await assertFails(addDoc(yol(db(OGR)), gb(OGR, 'ogrenci')));
    await assertFails(addDoc(yol(db(VELI1)), gb(VELI2)));
    await assertFails(addDoc(yol(db(VELI1)), gb(VELI1, 'ogretmen')));
    await assertFails(addDoc(yol(db(VELI1)), gb(VELI1, 'veli', { okundu: true })));
    await assertFails(addDoc(yol(db(VELI1)), gb(VELI1, 'veli', { metin: '' })));
  });

  it('öğrenci okur ve yalnızca okundu işaretler', async () => {
    await hazirBaglanti(VELI1);
    const ref = await addDoc(collection(db(VELI1), 'ogrenciler', OGR, 'geribildirimler'), gb(VELI1));
    const oRef = doc(db(OGR), ref.path);
    await assertSucceeds(getDoc(oRef));
    await assertSucceeds(updateDoc(oRef, { okundu: true }));
    await assertFails(updateDoc(oRef, { metin: 'değişti' }));
    await assertFails(getDoc(doc(db(YABANCI), ref.path)));
  });
});

describe('diğer', () => {
  it('sunucu koleksiyonları istemciye kapalı', async () => {
    await assertFails(getDoc(doc(db(OGR), 'sunucuDurumu', 'x')));
    await assertFails(setDoc(doc(db(OGR), 'satinalmalar', 'x'), { a: 1 }));
  });
});
