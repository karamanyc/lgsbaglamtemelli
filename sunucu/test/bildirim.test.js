import { describe, expect, it, vi } from 'vitest';
import { fcmMesaji, kullanicilaraGonder } from '../src/bildirim.js';

describe('kullanicilaraGonder', () => {
  it('tokenı olan kullanıcılara gönderir, ölü tokenları siler, geçici hatada silmez', async () => {
    const d = {
      kullanicilariGetir: vi.fn(async () => new Map([
        ['a', { fcmTokens: ['t1', 't2', 't3'] }],
        ['b', { fcmTokens: [] }],
      ])),
      cokluGonder: vi.fn(async () => ({
        responses: [
          { success: true },
          { success: false, error: { code: 'messaging/registration-token-not-registered' } },
          { success: false, error: { code: 'messaging/internal-error' } },
        ],
      })),
      tokenlariSil: vi.fn(async () => {}),
    };
    const s = await kullanicilaraGonder(d, ['a', 'b', 'a', 'c'], { baslik: 'B', govde: 'G' });
    expect(d.kullanicilariGetir).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(d.cokluGonder).toHaveBeenCalledTimes(1);
    expect(d.tokenlariSil).toHaveBeenCalledWith('a', ['t2']);
    expect(s).toEqual({ gonderilen: 1, silinen: 1 });
  });

  it('boş hedefte hiçbir şey yapmaz', async () => {
    const d = { kullanicilariGetir: vi.fn(), cokluGonder: vi.fn(), tokenlariSil: vi.fn() };
    expect(await kullanicilaraGonder(d, [], { baslik: '', govde: '' })).toEqual({ gonderilen: 0, silinen: 0 });
    expect(d.kullanicilariGetir).not.toHaveBeenCalled();
  });

  it('FCM mesajında data değerleri metne çevrilir', () => {
    const m = fcmMesaji(['t'], { baslik: 'B', govde: 'G', veri: { tur: 'konuBitti', sayi: 3, bos: undefined } });
    expect(m.data).toEqual({ tur: 'konuBitti', sayi: '3', bos: '' });
    expect(m.notification).toEqual({ title: 'B', body: 'G' });
    expect(m.apns.payload.aps.sound).toBe('default');
  });
});
