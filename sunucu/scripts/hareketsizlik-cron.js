// Render cron işi: web servisindeki /cron/hareketsizlik ucunu çağırır.
// Ücretsiz plandaki web servisi uyuyor olabilir; ilk istek ~1 dk sürebilir,
// bu yüzden uzun zaman aşımı ve birkaç deneme var.

const taban = String(process.env.SUNUCU_URL || '').replace(/\/+$/, '');
const sir = process.env.CRON_SECRET || '';

if (!taban || !sir) {
  console.error('SUNUCU_URL ve CRON_SECRET gerekli');
  process.exit(1);
}

async function dene(n) {
  try {
    const res = await fetch(`${taban}/cron/hareketsizlik`, {
      method: 'POST',
      headers: { 'x-cron-secret': sir, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(120_000),
    });
    const metin = await res.text();
    console.log(`deneme ${n}: HTTP ${res.status} ${metin}`);
    if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    if (n >= 3) throw err;
    console.warn(`deneme ${n} başarısız (${err.message}), 20 sn sonra yeniden`);
    await new Promise((r) => setTimeout(r, 20_000));
    return dene(n + 1);
  }
}

dene(1)
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('cron başarısız:', err.message);
    process.exit(1);
  });
