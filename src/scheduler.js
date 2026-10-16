(function (root) {
  const minutes = text => {
    if (typeof text !== 'string' || !/^\d{2}:\d{2}$/.test(text)) return null;
    const [h, m] = text.split(':').map(Number);
    return h < 24 && m < 60 ? h * 60 + m : null;
  };
  const format = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  function schedule(tasks, config, now = new Date()) {
    const start = minutes(config.start), end = minutes(config.end);
    const lunchStart = minutes(config.lunchStart), lunchEnd = minutes(config.lunchEnd);
    if (start === null || end === null || start >= end) throw new Error('工作开始时间必须早于结束时间，不支持跨夜排程。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(config.date || '')) throw new Error('请选择计划日期。');
    const [year, month, day] = config.date.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('计划日期无效。');
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (date < today) throw new Error('请选择今天或之后的日期。');
    if (config.lunch && (lunchStart === null || lunchEnd === null || lunchStart >= lunchEnd)) throw new Error('午休开始时间必须早于结束时间。');
    let cursor = date.getTime() === today.getTime() ? Math.max(start, now.getHours() * 60 + now.getMinutes() + (now.getSeconds() || now.getMilliseconds() ? 1 : 0)) : start;
    const slots = config.lunch ? [[start, Math.min(end, lunchStart)], [Math.max(start, lunchEnd), end]].filter(([a, b]) => a < b) : [[start, end]];
    const ordered = tasks.filter(t => !t.done).map((t, index) => ({ ...t, index, due: t.deadline ? minutes(t.deadline) : null }));
    for (const t of ordered) {
      if (!Number.isInteger(t.duration) || t.duration < 1 || t.duration > 480) throw new Error(`“${t.title}”的预计用时须为 1～480 分钟整数。`);
      if (t.deadline && t.due === null) throw new Error(`“${t.title}”的截止时间无效。`);
    }
    ordered.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || (b.priority || 0) - (a.priority || 0) || a.index - b.index);
    const entries = [], unscheduled = [];
    for (const task of ordered) {
      let left = task.duration, nextCursor = cursor;
      const segments = [];
      for (const [a, b] of slots) {
        const from = Math.max(a, nextCursor);
        if (from >= b) continue;
        const used = Math.min(left, b - from);
        segments.push({ start: from, end: from + used });
        left -= used; nextCursor = from + used;
        if (!left) break;
      }
      if (left) { unscheduled.push({ id: task.id, title: task.title, reason: '剩余工作时间不足，未安排；请缩短用时或改期。' }); continue; }
      cursor = nextCursor;
      entries.push({ id: task.id, title: task.title, segments, late: task.due !== null && cursor > task.due, deadline: task.deadline || '' });
    }
    return { entries, unscheduled };
  }
  const api = { schedule, minutes, format };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WorkScheduler = api;
})(globalThis);
