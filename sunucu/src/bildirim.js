// Kullanıcılara push gönderimi + kalıcı olarak geçersiz token temizliği.
// Firebase'e bağımlı değil: bağımlılıklar dışarıdan verilir (testte taklit).

/** Kalıcı olarak ölmüş token hataları. Geçici hatalarda token SİLİNMEZ. */
export const OLU_TOKEN_KODLARI = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * @param {object} d
 * @param {(uidler: string[]) => Promise<Map<string, object>>} d.kullanicilariGetir
 * @param {(tokenlar: string[], mesaj: object) => Promise<{responses: {success: boolean, error?: {code: string}}[]}>} d.cokluGonder
 * @param {(uid: string, tokenlar: string[]) => Promise<void>} d.tokenlariSil
 * @param {string[]} uidler
 * @param {{baslik: string, govde: string, veri?: Record<string,string>}} mesaj
 * @returns {Promise<{gonderilen: number, silinen: number}>}
 */
export async function kullanicilaraGonder(d, uidler, mesaj) {
  const tekil = [...new Set(uidler.filter(Boolean))];
  if (tekil.length === 0) return { gonderilen: 0, silinen: 0 };
  const kullanicilar = await d.kullanicilariGetir(tekil);

  let gonderilen = 0;
  let silinen = 0;
  for (const uid of tekil) {
    const tokenlar = [...new Set((kullanicilar.get(uid)?.fcmTokens || []).filter((t) => typeof t === 'string' && t))];
    if (tokenlar.length === 0) continue;
    const sonuc = await d.cokluGonder(tokenlar, mesaj);
    const olu = [];
    sonuc.responses.forEach((r, i) => {
      if (r.success) gonderilen += 1;
      else if (r.error && OLU_TOKEN_KODLARI.has(r.error.code)) olu.push(tokenlar[i]);
    });
    if (olu.length > 0) {
      await d.tokenlariSil(uid, olu);
      silinen += olu.length;
    }
  }
  return { gonderilen, silinen };
}

/** FCM çoklu mesajı (firebase-admin MulticastMessage). */
export function fcmMesaji(tokenlar, { baslik, govde, veri = {} }) {
  return {
    tokens: tokenlar,
    notification: { title: baslik, body: govde },
    data: Object.fromEntries(Object.entries(veri).map(([k, v]) => [k, String(v ?? '')])),
    apns: { payload: { aps: { sound: 'default' } } },
    android: { priority: 'high', notification: { sound: 'default' } },
  };
}
