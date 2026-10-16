(() => {
  const get = id => document.getElementById(`competitor-${id}`);
  const api = window.competitor;
  const stateNames = { queued: '准备中', running: '采集中', needs_keywords: '请核对核心词', complete: '范围内采集完成', partial: '部分完成或访问失败', cancelled: '已取消' };
  let jobId = null, polling = false, runningJob = false, suggestedJob = null;
  const status = text => { get('status').textContent = text; };
  function render(job) {
    const running = ['running', 'queued'].includes(job.status); runningJob = running;
    get('start').disabled = running; get('cancel').disabled = !running;
    get('resume').disabled = !['partial', 'cancelled'].includes(job.status);
    get('export').disabled = !job.results.length;
    status(`${stateNames[job.status] || job.status}：${job.message || '准备中'}`);
    get('summary').textContent = `原始命中 ${job.hits.length}；唯一候选 ${job.candidateCount || 0}；详情成功 ${Object.keys(job.details).length}；直接竞品规则候选 ${job.results.filter(r => r.classification === '直接竞品（规则候选）').length}`;
    get('errors').replaceChildren();
    job.errors.forEach(error => { const li = document.createElement('li'); li.textContent = error; get('errors').append(li); });
    get('results').replaceChildren();
    for (const row of job.results) {
      const tr = document.createElement('tr');
      for (const text of [row.asin, `${row.title}\n${row.classification}`, String(row.score)]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
      const details = document.createElement('details'), summary = document.createElement('summary'), explanation = document.createElement('p');
      summary.textContent = '查看依据'; explanation.textContent = `${row.explanation}；来源命中数 ${row.frequency}；${row.ruleVersion}`; details.append(summary, explanation); tr.children[1].append(details); get('results').append(tr);
    }
    if (job.status === 'needs_keywords' && job.suggestedKeywords?.length && suggestedJob !== job.id) { suggestedJob = job.id; get('keywords').value = job.suggestedKeywords.join('\n'); status(job.message + ' 建议词已填入，请检查并再次点击开始采集。'); }
  }
  async function poll() {
    if (!jobId || polling) return;
    polling = true;
    try { render(await api.status(jobId)); } catch(e) { status(e.message); }
    finally { polling = false; }
  }
  get('form').onsubmit = async e => {
    e.preventDefault(); get('start').disabled = true;
    try {
      jobId = await api.start({ asin: get('asin').value, marketplace: get('market').value, keywords: get('keywords').value, pages: Number(get('pages').value), limit: Number(get('limit').value), browserMode: get('browser-mode').checked });
      await poll();
    } catch(e) { status(e.message); get('start').disabled = false; }
  };
  get('cancel').onclick = async () => { try { await api.cancel(jobId); status('已请求取消，等待当前请求结束（最长约30秒）'); } catch(e) { status(e.message); } };
  get('resume').onclick = async () => { try { await api.resume(jobId); await poll(); } catch(e) { status(e.message); } };
  get('export').onclick = async () => { try { if (await api.export(jobId)) status('Excel 已保存（概览 / 全量候选 / 直接竞品）'); } catch(e) { status(e.message); } };
  get('refresh').onclick = async () => {
    try {
      const list = await api.list(); get('history').replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择历史任务'; get('history').append(placeholder);
      list.forEach(job => { const option = document.createElement('option'); option.value = job.id; option.textContent = `${job.asin} · ${new Date(job.createdAt).toLocaleString()} · ${stateNames[job.status] || job.status}`; get('history').append(option); });
    } catch(e) { status(e.message); }
  };
  get('history').onchange = async () => { if (get('history').value) { jobId = get('history').value; await poll(); } };
  setInterval(() => { if (runningJob) poll(); }, 2000);
})();
