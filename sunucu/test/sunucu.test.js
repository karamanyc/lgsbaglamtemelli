import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sunucuOlustur } from '../src/sunucu.js';

let sunucu;
let taban;
const gelen = [];

beforeAll(async () => {
  sunucu = sunucuOlustur(async (istek) => {
    gelen.push(istek);
    return { durum: 200, veri: { yol: istek.yol, govde: istek.govde ?? null } };
  });
  await new Promise((r) => sunucu.listen(0, '127.0.0.1', r));
  taban = `http://127.0.0.1:${sunucu.address().port}`;
});
afterAll(() => new Promise((r) => sunucu.close(r)));

describe('HTTP katmanı', () => {
  it('JSON gövdeyi çözer, sondaki / işaretini atar, CORS başlığı ekler', async () => {
    const r = await fetch(`${taban}/bildir/`, { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toEqual({ yol: '/bildir', govde: { a: 1 } });
  });

  it('bozuk JSON 400', async () => {
    const r = await fetch(`${taban}/bildir`, { method: 'POST', body: '{bozuk' });
    expect(r.status).toBe(400);
  });

  it('başlıklar küçük harfle işleyiciye geçer', async () => {
    await fetch(`${taban}/saglik`, { headers: { Authorization: 'Bearer x' } });
    expect(gelen.at(-1).basliklar.authorization).toBe('Bearer x');
  });
});
