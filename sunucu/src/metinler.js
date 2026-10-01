// Konu adları ve bildirim metinleri. Kısa, somut, Türkçe.

export const KONULAR = {
  'carpanlar-katlar': 'Çarpanlar ve Katlar',
  'uslu-ifadeler': 'Üslü İfadeler',
  'karekoklu-ifadeler': 'Kareköklü İfadeler',
  'veri-analizi': 'Veri Analizi',
  olasilik: 'Basit Olayların Olma Olasılığı',
  'cebirsel-ifadeler': 'Cebirsel İfadeler ve Özdeşlikler',
  'dogrusal-denklemler': 'Doğrusal Denklemler',
  esitsizlikler: 'Eşitsizlikler',
  ucgenler: 'Üçgenler',
  'eslik-benzerlik': 'Eşlik ve Benzerlik',
  'donusum-geometrisi': 'Dönüşüm Geometrisi',
  'geometrik-cisimler': 'Geometrik Cisimler',
};

const BASAMAK_ADI = { basit: 'basit', orta: 'orta', zor: 'zor' };

/** ilerleme.basamak yeni basamağı gösterir; geçilen basamak bir öncekidir. */
export const GECILEN_BASAMAK = { orta: 'basit', zor: 'orta', bitti: 'zor' };

export const kisalt = (metin, n = 110) => {
  const s = String(metin || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

export const metinler = {
  konuBitti: (ad, konuId) => ({
    baslik: 'Konu tamamlandı',
    govde: `${ad} ${KONULAR[konuId]} konusunu bitirdi. Raporu hazır.`,
  }),

  basamakGecti: (ad, konuId, gecilen) => ({
    baslik: 'Yeni basamak',
    govde: `${ad} ${KONULAR[konuId]} konusunda ${BASAMAK_ADI[gecilen]} basamağını geçti.`,
  }),

  geribildirimOgrenciye: (yazanAd, metin) => ({
    baslik: 'Yeni geri bildirim',
    govde: metin ? `${yazanAd}: "${kisalt(metin)}"` : `${yazanAd} sana bir not yazdı.`,
  }),

  geribildirimIzleyiciye: (yazanAd, ogrenciAd, metin) => ({
    baslik: 'Yeni geri bildirim',
    govde: metin
      ? `${yazanAd}, ${ogrenciAd} için not yazdı: "${kisalt(metin, 90)}"`
      : `${yazanAd}, ${ogrenciAd} için bir not yazdı.`,
  }),

  hareketsizOgrenciye: () => ({
    baslik: 'Kaldığın yerde seni bekliyor',
    govde: '3 gündür soru çözmedin. Bugün 10 dakika ayır, kaldığın yerden devam et.',
  }),

  hareketsizIzleyiciye: (ogrenciAd) => ({
    baslik: 'Hareketsizlik hatırlatması',
    govde: `${ogrenciAd} 3 gündür soru çözmedi. Küçük bir hatırlatma iyi gelebilir.`,
  }),
};
