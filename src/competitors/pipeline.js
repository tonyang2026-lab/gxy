const P = require('./parse');
const { score, RULE_VERSION } = require('./score');
function options(input) {
  if (!input || typeof input !== 'object') throw new Error('采集参数无效');
  const marketplace = Object.hasOwn(P.HOSTS, input.marketplace) ? input.marketplace : 'US';
  const keywords = [...new Set(String(input.keywords || '').split(/[\n,，]/).map(s => s.trim()).filter(Boolean))];
  if (keywords.length > 5 || keywords.some(k => k.length > 100)) throw new Error('核心词最多5个，每个不超过100字符');
  const pages = Number(input.pages || 1), limit = Number(input.limit || 30);
  if (!Number.isInteger(pages) || pages < 1 || pages > 5 || !Number.isInteger(limit) || limit < 1 || limit > 150) throw new Error('搜索页数须为1～5，详情数量须为1～150');
  return { asin: P.asin(input.asin), marketplace, keywords, pages, limit };
}
function init(input, id) { return { id, options: options(input), status: 'queued', target: null, queue: null, hits: [], details: {}, results: [], errors: [], createdAt: new Date().toISOString(), ruleVersion: RULE_VERSION }; }
async function run(job, deps) {
  const { request, save, cancelled = () => false, wait = ms => new Promise(r => setTimeout(r, ms)), delay = 5000 } = deps;
  const base = `https://${P.HOSTS[job.options.marketplace]}`;
  let requests = 0;
  const checkpoint = () => { job.updatedAt = new Date().toISOString(); save(job); };
  async function get(url) {
    if (cancelled()) throw new Error('已取消，可稍后继续');
    if (requests++) await wait(delay);
    if (cancelled()) throw new Error('已取消，可稍后继续');
    const u = new URL(url);
    if (u.origin !== base) throw new Error('拒绝访问非所选站点的地址');
    const response = await request(url);
    if (!response.ok) throw new Error(`采集请求 HTTP ${response.status}，已停止；可保留进度后稍后继续`);
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > 12000000) throw new Error('页面过大，已停止');
    return html;
  }
  job.status = 'running'; job.errors = []; checkpoint();
  try {
    if (!job.target) {
      job.message = '读取目标商品'; checkpoint();
      job.target = { asin: job.options.asin, ...P.detail(await get(`${base}/dp/${job.options.asin}`)) };
      if (!job.options.keywords.length) {
        job.suggestedKeywords = P.suggest(job.target.title);
        job.status = 'needs_keywords'; job.message = '已读取商品。请核对自动提词建议，填写4～5个核心词后重新开始。'; checkpoint(); return job;
      }
      checkpoint();
    }
    if (!job.target.bsrPath) job.errors.push('目标页未找到可用榜单链接，BSR未采集；结果只覆盖所选关键词搜索。');
    if (!job.queue) {
      job.queue = [];
      if (job.target.bsrPath) for (let page = 1; page <= 2; page++) job.queue.push({ source: 'BSR', keyword: '', page, url: `${base}${job.target.bsrPath.split('?')[0]}?pg=${page}` });
      for (const keyword of job.options.keywords) for (let page = 1; page <= job.options.pages; page++) job.queue.push({ source: 'SEARCH', keyword, page, url: `${base}/s?k=${encodeURIComponent(keyword)}&page=${page}` });
      checkpoint();
    }
    for (const item of job.queue) {
      if (item.done) continue;
      job.message = `采集 ${item.source} ${item.keyword} 第${item.page}页`; checkpoint();
      const rows = P.listing(await get(item.url), item.source, item.keyword, item.page);
      job.hits.push(...rows); item.done = true; checkpoint();
    }
    const candidates = P.merge(job.hits, job.options.asin).sort((a, b) => b.frequency - a.frequency || a.asin.localeCompare(b.asin));
    const selected = candidates.slice(0, job.options.limit);
    job.candidateCount = candidates.length;
    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      if (job.details[row.asin]) continue;
      job.message = `读取候选详情 ${i + 1}/${selected.length}：${row.asin}`; checkpoint();
      job.details[row.asin] = P.detail(await get(`${base}/dp/${row.asin}`)); checkpoint();
    }
    job.status = 'complete'; job.message = '采集与规则评分完成（范围限于所选页数及详情数量）';
  } catch (error) {
    job.status = cancelled() ? 'cancelled' : 'partial';
    job.message = error.message; job.errors.push(error.message);
  } finally {
    if (job.target) {
      const candidates = P.merge(job.hits, job.options.asin);
      job.candidateCount = candidates.length;
      job.results = candidates.map(c => score(job.target, { ...c, ...job.details[c.asin], detailLoaded: !!job.details[c.asin] }, job.options.keywords)).sort((a, b) => b.score - a.score || a.asin.localeCompare(b.asin));
    }
    checkpoint();
  }
  return job;
}
module.exports = { init, options, run };
