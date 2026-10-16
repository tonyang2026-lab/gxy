const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');
const P = require('../src/competitors/parse');
const { score } = require('../src/competitors/score');
const Pipeline = require('../src/competitors/pipeline');
const { workbook } = require('../src/competitors/export');
const target = fs.readFileSync(path.join(__dirname, 'fixtures/target.html'), 'utf8');
const search = fs.readFileSync(path.join(__dirname, 'fixtures/search.html'), 'utf8');
const input = { asin: 'B000000001', marketplace: 'US', keywords: 'countertop ice maker,portable ice machine', pages: 1, limit: 10 };
test('parses explicit price components without losing decimals or inventing currency', () => {
  assert.equal(P.asin('https://www.amazon.com/dp/B000000001?x=1'), 'B000000001');
  assert.throws(() => P.asin('invalid'));
  assert.equal(P.detail(target).brand, 'Acme');
  const rows = P.listing(search, 'SEARCH', 'ice maker', 1);
  assert.equal(rows[0].price, 39.99); assert.equal(rows[0].currency, 'UNKNOWN_DOLLAR'); assert.equal(rows[1].price, null);
  assert.throws(() => P.detail('<title>Robot Check</title>'), /拦截/);
  assert.throws(() => P.listing('<html>No results</html>', 'SEARCH', '', 1), /未解析/);
});
test('dedup retains distinct search sources, excludes target and records page/card position', () => {
  const rows = P.listing(search, 'SEARCH', 'ice maker', 1);
  const merged = P.merge([...rows, ...rows, ...rows.map(r => ({ ...r, keyword: 'portable', page: 2 }))], input.asin);
  assert.equal(merged.length, 2); assert.equal(merged[0].frequency, 2); assert.equal(merged[0].keywords.length, 2);
  assert.equal(merged[0].bestPosition, '第1页第1张卡片');
});
test('rule scores are deterministic and do not compare uncertain currency or claim probabilities', () => {
  const t = P.detail(target), c = { title: 'Other Countertop Ice Maker Portable Ice Machine', brand: 'Other', price: 500, currency: 'UNKNOWN_DOLLAR', frequency: 2, detailLoaded: true };
  const result = score(t, c, ['countertop ice maker', 'portable ice machine']);
  assert.deepEqual(result, score(t, c, ['countertop ice maker', 'portable ice machine']));
  assert.match(result.classification, /直接竞品/); assert.match(result.explanation, /不比较价格/); assert.equal(result.probability, undefined);
  assert.match(score(t, { ...c, detailLoaded: false }, []).classification, /信息不足/);
  assert.match(score(t, { ...c, title: 'Replacement Filter for Ice Maker' }, ['ice maker']).classification, /配件/);
  assert.equal(score(t, { ...c, brand: 'Acme' }, []).classification, '同品牌家族');
});
test('pipeline checkpoints, stops on access denial, resumes without repeating successful search pages', async () => {
  const job = Pipeline.init(input, 'fixture'); let blocked = true; const urls = [], waits = [], snapshots = [];
  const deps = { request: async url => {
    urls.push(url);
    if (url.includes('/s?')) return { ok: true, text: async () => search };
    if (url.endsWith('/B000000003') && blocked) return { ok: false, status: 403 };
    return { ok: true, text: async () => target.replace('Acme', 'Other') };
  }, save: j => snapshots.push(JSON.parse(JSON.stringify(j))), wait: async ms => waits.push(ms) };
  await Pipeline.run(job, deps);
  assert.equal(job.status, 'partial'); assert.equal(job.results.length, 2);
  assert.ok(job.results.some(r => !r.detailLoaded)); assert.ok(waits.every(ms => ms === 5000));
  const searchRequests = urls.filter(u => u.includes('/s?')).length;
  blocked = false; await Pipeline.run(job, deps);
  assert.equal(job.status, 'complete'); assert.equal(urls.filter(u => u.includes('/s?')).length, searchRequests);
  assert.equal(job.results.filter(r => r.detailLoaded).length, 2); assert.ok(snapshots.length > 5);
});
test('empty keywords requires confirmation, cancellation does not issue requests', async () => {
  const job = Pipeline.init({ ...input, keywords: '' }, 'suggest');
  await Pipeline.run(job, { request: async () => ({ ok: true, text: async () => target }), save() {} });
  assert.equal(job.status, 'needs_keywords'); assert.ok(job.suggestedKeywords.length);
  const cancel = Pipeline.init(input, 'cancel');
  await Pipeline.run(cancel, { request: async () => { throw new Error('must not request'); }, save() {}, cancelled: () => true });
  assert.equal(cancel.status, 'cancelled'); assert.equal(cancel.hits.length, 0);
});
test('Excel exports three real sheets and untrusted text remains text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gxy-export-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = Pipeline.init(input, 'export'); job.updatedAt = '2026-10-16'; job.message = 'fixture';
  job.results = [score(P.detail(target), { asin: 'B000000002', title: '=HYPERLINK("evil") Countertop Ice Maker', brand: 'Other', frequency: 2, detailLoaded: true, keywords: ['ice maker'], evidence: [] }, ['ice maker'])];
  const file = path.join(dir, 'report.xlsx'); await workbook(job, file);
  const read = new ExcelJS.Workbook(); await read.xlsx.readFile(file);
  assert.deepEqual(read.worksheets.map(s => s.name), ['概览', '全量候选', '直接竞品']);
  assert.equal(read.getWorksheet('全量候选').getCell('B2').type, ExcelJS.ValueType.String);
  assert.equal(read.getWorksheet('全量候选').rowCount, 2);
});
test('BSR parser preserves ranks and detail page discovers a provided BSR link', () => {
  const html = '<div id="gridItemRoot"><span class="zg-bdg-text">#12</span><a href="/dp/B000000002"><div class="p13n-sc-truncate-desktop-type2">Portable Ice Maker</div></a></div>';
  const rows = P.listing(html, 'BSR', '', 1);
  assert.equal(rows[0].asin, 'B000000002'); assert.equal(rows[0].rank, 12);
  assert.equal(P.detail(target + '<a href="/gp/bestsellers/appliances/123/ref=zg_bs_nav">See bestsellers</a>').bsrPath, '/gp/bestsellers/appliances/123/ref=zg_bs_nav');
});
