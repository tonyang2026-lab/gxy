const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const Pipeline = require('./pipeline');
const { workbook } = require('./export');
function register({ app, ipcMain, session, dialog, win }) {
  const root = path.join(app.getPath('userData'), 'competitors');
  fs.mkdirSync(root, { recursive: true });
  let active = null;
  const idPath = id => { if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务编号无效'); return path.join(root, id); };
  function save(job) { const dir = idPath(job.id); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'job.json'); fs.writeFileSync(file + '.tmp', JSON.stringify(job)); fs.renameSync(file + '.tmp', file); }
  function read(id) { return JSON.parse(fs.readFileSync(path.join(idPath(id), 'job.json'), 'utf8')); }
  function launch(job) {
    if (active) throw new Error('已有采集任务运行中，请等待或先取消');
    const running = { id: job.id, cancelled: false, job }; active = running;
    const transport = session.fromPartition('competitor-public');
    Pipeline.run(job, {
      request: async url => {
        const response = await transport.fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!response.ok) return response;
        const html = await response.text();
        if (Buffer.byteLength(html) > 12000000) throw new Error('页面超过12MB，已停止');
        const filename = createHash('sha256').update(url).digest('hex') + '.html';
        fs.mkdirSync(path.join(idPath(job.id), 'pages'), { recursive: true });
        fs.writeFileSync(path.join(idPath(job.id), 'pages', filename), html);
        return { ok: true, text: async () => html };
      },
      save, cancelled: () => running.cancelled
    }).catch(error => { job.status = 'partial'; job.message = `保存或运行失败：${error.message}`; }).finally(() => { active = null; });
    return job.id;
  }
  ipcMain.handle('competitor-start', (_, input) => { if (active) throw new Error('已有采集任务运行中'); const job = Pipeline.init(input, randomUUID()); save(job); return launch(job); });
  ipcMain.handle('competitor-status', (_, id) => {
    const job = active?.id === id ? active.job : read(id);
    if (job.status === 'running' && active?.id !== id) { job.status = 'partial'; job.message = '上次运行已中断，可以继续'; }
    return job;
  });
  ipcMain.handle('competitor-list', () => fs.readdirSync(root).filter(id => /^[a-f0-9-]{36}$/.test(id)).flatMap(id => { try { const j = read(id); return [{ id, createdAt: j.createdAt, asin: j.options.asin, status: j.status }]; } catch { return []; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30));
  ipcMain.handle('competitor-resume', (_, id) => { const job = read(id); if (job.status === 'needs_keywords') throw new Error('请填写核心词后新建采集'); if (job.status === 'complete') throw new Error('此任务已完成，如需更新请新建采集'); return launch(job); });
  ipcMain.handle('competitor-cancel', (_, id) => { if (active?.id === id) active.cancelled = true; });
  ipcMain.handle('competitor-export', async (_, id) => {
    const job = active?.id === id ? JSON.parse(JSON.stringify(active.job)) : read(id);
    if (!job.results.length) throw new Error('尚无可导出的候选结果');
    const choice = await dialog.showSaveDialog(win, { defaultPath: `竞品库-${job.options.asin}.xlsx`, filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] });
    if (choice.canceled || !choice.filePath) return false;
    await workbook(job, choice.filePath); return true;
  });
}
module.exports = { register };
