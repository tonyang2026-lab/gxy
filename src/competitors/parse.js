const cheerio = require('cheerio');
const HOSTS = { US: 'www.amazon.com', UK: 'www.amazon.co.uk', DE: 'www.amazon.de', FR: 'www.amazon.fr', JP: 'www.amazon.co.jp', AE: 'www.amazon.ae', SA: 'www.amazon.sa' };
function asin(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})(?:[/?]|$)/i);
  const result = (match ? match[1] : text).toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(result)) throw new Error('请输入10位 ASIN，或含 /dp/ASIN 的商品链接');
  return result;
}
function load(html) {
  if (/validateCaptcha|automated access|robot check|bm-verify|enter the characters you see/i.test(html)) throw new Error('Amazon 返回验证页，已暂停。请在采集窗口手动完成验证，再回主窗口点击“继续”；如反复出现请停止采集');
  return cheerio.load(html);
}
const clean = text => text.replace(/\s+/g, ' ').trim();
function price($, scope) {
  const box = scope.find('.a-price').not('.a-text-price').first();
  const full = clean(box.find('.a-offscreen').first().text());
  const whole = clean(box.find('.a-price-whole').first().text());
  const fraction = clean(box.find('.a-price-fraction').first().text());
  const symbol = clean(box.find('.a-price-symbol').first().text());
  const text = full || (whole ? `${symbol}${whole.replace(/[.,]$/, '')}${fraction ? '.' + fraction : ''}` : '');
  const currency = /\bAED\b|د\s*\.?\s*إ/i.test(text) ? 'AED' : /\bSAR\b|ر\s*\.?\s*س|﷼/i.test(text) ? 'SAR' : /US\$|USD/.test(text) ? 'USD' : /S\$|SGD/.test(text) ? 'SGD' : /CA\$|CDN\$|CAD/.test(text) ? 'CAD' : /A\$|AUD/.test(text) ? 'AUD' : /£/.test(text) ? 'GBP' : /€/.test(text) ? 'EUR' : /￥|¥|JPY/.test(text) ? 'JPY' : /\$/.test(text) ? 'UNKNOWN_DOLLAR' : null;
  const normalized = text.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0)).replace(/٫/g, '.').replace(/٬/g, '');
  let raw = normalized.match(/\d[\d.,]*/)?.[0] || '';
  if (raw.includes(',') && raw.includes('.')) raw = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  else if (/,\d{2}$/.test(raw) && currency !== 'JPY') raw = raw.replace(',', '.');
  else raw = raw.replace(/,/g, '');
  const value = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  return { price: value, currency, priceText: text || null };
}
function detail(html) {
  const $ = load(html);
  const title = clean($('#productTitle').text());
  if (!title) throw new Error('商品页未找到标题，页面结构可能变化或未完整返回');
  const byline = clean($('#bylineInfo').text());
  const brand = byline.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '');
  const category = clean($('#wayfinding-breadcrumbs_feature_div').text());
  const nodeLink = $('#wayfinding-breadcrumbs_feature_div a').toArray().map(a => $(a).attr('href') || '').reverse().find(h => /[?&]node=\d+/.test(h));
  const node = nodeLink?.match(/[?&]node=(\d+)/)?.[1] || null;
  const bsrPath = $('a[href*="/gp/bestsellers/"], a[href*="/zgbs/"]').toArray().map(a => $(a).attr('href') || '').find(h => /^\/(?:gp\/bestsellers|zgbs)\/[a-z0-9/]+/i.test(h)) || null;
  return { title, brand, category, node, bsrPath, ...price($, $('#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #apex_desktop').first()) };
}
function listing(html, source, keyword, page) {
  const $ = load(html); const rows = [];
  let cards = $('[data-component-type="s-search-result"][data-asin]');
  if (source === 'BSR') cards = $('[id="gridItemRoot"], .zg-grid-general-faceout, .zg-item-immersion');
  cards.each((index, el) => {
    const card = $(el); const href = card.find('a[href*="/dp/"], a[href*="/gp/product/"]').first().attr('href') || '';
    let id;
    try { id = asin(card.attr('data-asin') || href); } catch { return; }
    const title = clean(card.find('h2 span, h2, .p13n-sc-truncate-desktop-type2, .p13n-sc-truncate, ._cDEzb_p13n-sc-css-line-clamp-3_g3dy1').first().text()) || clean(card.find('img').first().attr('alt') || '');
    if (!title) return;
    const rankText = clean(card.find('.zg-bdg-text').first().text());
    rows.push({ asin: id, title, ...price($, card), source, keyword, page, position: index + 1, rank: source === 'BSR' ? Number(rankText.replace(/\D/g, '')) || null : null });
  });
  if (!rows.length) throw new Error('页面未解析到商品，可能无结果、页面变化或访问受限；未按成功处理');
  return rows;
}
function merge(hits, targetAsin) {
  const map = new Map();
  for (const hit of hits) {
    if (hit.asin === targetAsin) continue;
    if (!map.has(hit.asin)) map.set(hit.asin, { asin: hit.asin, title: hit.title, price: hit.price, currency: hit.currency, priceText: hit.priceText, evidence: [] });
    const row = map.get(hit.asin);
    const key = x => `${x.source}|${x.keyword}|${x.page}`;
    if (!row.evidence.some(e => key(e) === key(hit))) row.evidence.push({ source: hit.source, keyword: hit.keyword, page: hit.page, position: hit.position, rank: hit.rank });
  }
  return [...map.values()].map(row => ({ ...row, frequency: row.evidence.length, bestPosition: row.evidence.filter(e => e.source === 'SEARCH').sort((a, b) => a.page - b.page || a.position - b.position).map(e => `第${e.page}页第${e.position}张卡片`)[0] || null, keywords: [...new Set(row.evidence.map(e => e.keyword).filter(Boolean))] }));
}
function suggest(title) {
  const stop = new Set('the a an and with for of in on to by from new portable brand visit store'.split(' '));
  const tokens = [...new Set((title.toLowerCase().match(/[a-z]{3,}/g) || []).filter(w => !stop.has(w)))];
  return Array.from({ length: Math.min(4, Math.max(0, tokens.length - 1)) }, (_, i) => tokens.slice(i, i + 2).join(' '));
}
module.exports = { HOSTS, asin, detail, listing, merge, suggest };
