(() => {
  const get = id => document.getElementById(id);
  const fields = ['date', 'start', 'end', 'lunchStart', 'lunchEnd'];
  const now = new Date();
  get('schedule-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let metadata = {};
  try {
    const saved = JSON.parse(localStorage.getItem('xiaoxing-schedule'));
    if (saved && typeof saved === 'object') {
      if (saved.metadata && typeof saved.metadata === 'object' && !Array.isArray(saved.metadata)) metadata = saved.metadata;
      for (const f of fields.filter(f => f !== 'date')) if (typeof saved.config?.[f] === 'string') get(`schedule-${f}`).value = saved.config[f];
      if (typeof saved.config?.lunch === 'boolean') get('schedule-lunch').checked = saved.config.lunch;
    }
  } catch { /* Keep defaults. */ }
  function config() { return { ...Object.fromEntries(fields.map(f => [f, get(`schedule-${f}`).value])), lunch: get('schedule-lunch').checked }; }
  function persist() {
    try { localStorage.setItem('xiaoxing-schedule', JSON.stringify({ config: config(), metadata })); }
    catch { get('schedule-status').textContent = '排程设置保存失败，请保留窗口。'; }
  }
  function invalidate() { get('schedule-output').replaceChildren(); get('schedule-status').textContent = '任务或设置已更新，请点击“安排日程”。'; }
  function controls(task) {
    const stored = metadata[task.id];
    const data = { duration: Number.isInteger(stored?.duration) ? stored.duration : 30, priority: [0, 1, 2].includes(stored?.priority) ? stored.priority : 1, deadline: typeof stored?.deadline === 'string' ? stored.deadline : '' };
    const box = document.createElement('div'); box.className = 'task-schedule';
    const label = (text, input) => { const el = document.createElement('label'); el.append(document.createTextNode(text), input); box.append(el); };
    const duration = document.createElement('input'); duration.type = 'number'; duration.min = '1'; duration.max = '480'; duration.value = data.duration; duration.setAttribute('aria-label', `${task.title}预计分钟`);
    const priority = document.createElement('select'); [['0', '低'], ['1', '普通'], ['2', '高']].forEach(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; priority.append(o); }); priority.value = data.priority; priority.setAttribute('aria-label', `${task.title}优先级`);
    const deadline = document.createElement('input'); deadline.type = 'time'; deadline.value = data.deadline; deadline.setAttribute('aria-label', `${task.title}当天截止时间，可留空`);
    [duration, priority, deadline].forEach(input => { input.disabled = task.done; input.onchange = () => { metadata[task.id] = { duration: Number(duration.value), priority: Number(priority.value), deadline: deadline.value }; invalidate(); persist(); }; });
    label('预计分钟', duration); label('优先级', priority); label('当天截止（可空）', deadline);
    return box;
  }
  fields.forEach(f => get(`schedule-${f}`).onchange = () => { invalidate(); persist(); });
  get('my-work-hours').onclick = () => {
    const hours = { start: '09:30', end: '18:00', lunchStart: '12:00', lunchEnd: '14:00' };
    for (const [field, value] of Object.entries(hours)) get(`schedule-${field}`).value = value;
    get('schedule-lunch').checked = true; invalidate(); persist();
  };
  get('schedule-lunch').onchange = () => { invalidate(); persist(); };
  window.scheduleUI = {
    controls, invalidate,
    generate(tasks) {
      get('schedule-output').replaceChildren();
      try {
        const input = tasks.map(t => ({ ...t, duration: 30, priority: 1, deadline: '', ...metadata[t.id] }));
        const result = WorkScheduler.schedule(input, config());
        const list = get('schedule-output');
        for (const entry of result.entries) {
          const li = document.createElement('li'); li.textContent = `${entry.segments.map(s => `${WorkScheduler.format(s.start)}–${WorkScheduler.format(s.end)}`).join(' / ')}　${entry.title}${entry.late ? `（超出 ${entry.deadline} 截止时间，请调整）` : ''}`;
          if (entry.late) li.className = 'schedule-warning'; list.append(li);
        }
        for (const task of result.unscheduled) { const li = document.createElement('li'); li.className = 'schedule-warning'; li.textContent = `${task.title}：${task.reason}`; list.append(li); }
        const late = result.entries.filter(e => e.late).length;
        get('schedule-status').textContent = `${config().date}：已安排 ${result.entries.length} 项，未排入 ${result.unscheduled.length} 项，超截止 ${late} 项。按截止时间优先、再按优先级排序；同条件保留清单顺序。`;
        persist();
      } catch (e) { get('schedule-status').textContent = e.message; }
    }
  };
})();
