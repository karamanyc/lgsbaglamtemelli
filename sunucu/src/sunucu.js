// HTTP giriş noktası (Render: `npm start`). Yerleşik http modülü; çerçeve yok.

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseBagimliliklari } from './firebase.js';
import { uygulamaOlustur } from './uygulama.js';

const AZAMI_GOVDE = 1024 * 1024; // Apple makbuzları büyük olabilir.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-cron-secret',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function govdeOku(req) {
  return new Promise((coz, reddet) => {
    let boyut = 0;
    const parcalar = [];
    req.on('data', (p) => {
      boyut += p.length;
      if (boyut > AZAMI_GOVDE) {
        reddet(Object.assign(new Error('govde_cok_buyuk'), { durum: 413 }));
        req.destroy();
        return;
      }
      parcalar.push(p);
    });
    req.on('end', () => coz(Buffer.concat(parcalar).toString('utf8')));
    req.on('error', reddet);
  });
}

export function sunucuOlustur(isle) {
  return createServer(async (req, res) => {
    const gonder = (durum, veri) => {
      res.writeHead(durum, { 'content-type': 'application/json; charset=utf-8', ...CORS });
      res.end(veri === null ? '' : JSON.stringify(veri));
    };
    try {
      const url = new URL(req.url, 'http://yerel');
      let govde;
      if (req.method === 'POST') {
        const ham = await govdeOku(req);
        try {
          govde = ham ? JSON.parse(ham) : {};
        } catch {
          return gonder(400, { hata: 'json_gecersiz' });
        }
      }
      const { durum, veri } = await isle({
        yontem: req.method,
        yol: url.pathname.replace(/\/+$/, '') || '/',
        basliklar: req.headers,
        sorgu: url.searchParams,
        govde,
      });
      gonder(durum, veri);
    } catch (err) {
      if (err.durum) return gonder(err.durum, { hata: err.message });
      console.error('istek hatası:', err);
      gonder(500, { hata: 'sunucu_hatasi' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const isle = uygulamaOlustur(firebaseBagimliliklari(process.env));
  const port = Number(process.env.PORT) || 10000;
  sunucuOlustur(isle).listen(port, '0.0.0.0', () => {
    console.log(`lgs-baglam-sunucu ${port} portunda`);
  });
}
