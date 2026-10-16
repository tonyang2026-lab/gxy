(() => {
  const get = id => document.getElementById(id);
  let plan = Planner.empty();
  try { plan = Planner.restore(JSON.parse(localStorage.getItem('xiaoxing-workflow'))); } catch { /* Start with an empty plan. */ }
  function save() { try { localStorage.setItem('xiaoxing-workflow', JSON.stringify(plan)); } catch { get('plan-status').textContent = '本地保存失败，请勿关闭窗口，以免丢失计划。'; } }
  function dispatch(action) { plan = Planner.change(plan, action); render(); save(); }
  function button(text, label, action, disabled = false) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', label); b.disabled = disabled; b.onclick = () => dispatch(action); return b;
  }
  function clock() {
    const task = plan.tasks.find(t => t.id === plan.activeId);
    if (!task) { get('work-clock').textContent = '选择一个任务开始专注'; return; }
    const remaining = plan.deadline !== null ? Math.max(0, plan.deadline - Date.now()) : task.remaining;
    const seconds = Math.ceil(remaining / 1000);
    get('work-clock').textContent = `${task.title} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} ${plan.deadline !== null ? '进行中' : remaining === 0 ? '时间到，完成后请打勾' : '已暂停'}`;
  }
  function render() {
    const done = plan.tasks.filter(t => t.done).length;
    const unfinished = plan.tasks.filter(t => !t.done);
    get('plan-progress').textContent = `${done}/${plan.tasks.length} 已完成 · 未完成预计 ${unfinished.reduce((n, t) => n + t.minutes, 0)} 分钟`;
    get('plan-next').textContent = unfinished.length ? `接下来：${unfinished[0].title}` : plan.tasks.length ? '全部完成啦，辛苦了！' : '把今天的工作拆成几个小步骤吧。';
    get('task-list').replaceChildren();
    plan.tasks.forEach((t, index) => {
      const row = document.createElement('li'); row.className = `task${t.done ? ' completed' : ''}${plan.activeId === t.id ? ' active' : ''}`;
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = t.done; check.setAttribute('aria-label', `完成：${t.title}`); check.onchange = () => { dispatch({ type: 'done', id: t.id }); say(t.done ? '这一步重新打开啦。' : '又完成一步，真棒！', true); };
      const text = document.createElement('span'); text.className = 'task-title'; text.textContent = `${index + 1}. ${t.title}（${t.minutes}分钟）`;
      const controls = document.createElement('div'); controls.className = 'task-controls';
      controls.append(button('↑', `上移 ${t.title}`, { type: 'move', id: t.id, direction: -1 }, index === 0), button('↓', `下移 ${t.title}`, { type: 'move', id: t.id, direction: 1 }, index === plan.tasks.length - 1));
      if (!t.done) controls.append(button('开始', `开始 ${t.title}`, { type: 'start', id: t.id }, t.remaining === 0 || (plan.activeId === t.id && plan.deadline !== null)), button('重计', `重置 ${t.title} 的计时`, { type: 'restart', id: t.id }));
      controls.append(button('删除', `删除 ${t.title}`, { type: 'remove', id: t.id }));
      row.append(check, text, controls); get('task-list').append(row);
    });
    get('pause-work').disabled = plan.deadline === null;
    clock();
  }
  get('task-form').onsubmit = e => {
    e.preventDefault();
    if (plan.tasks.length >= 100) { get('plan-status').textContent = '最多保存 100 个步骤，请先删除不需要的任务。'; return; }
    dispatch({ type: 'add', id: crypto.randomUUID(), title: get('task-title').value, minutes: Number(get('task-minutes').value) }); get('task-title').value = ''; get('task-title').focus();
  };
  get('pause-work').onclick = () => dispatch({ type: 'pause' });
  setInterval(() => {
    if (plan.deadline !== null && Date.now() >= plan.deadline) { dispatch({ type: 'tick' }); say('这一步的时间到啦！完成后打勾，再开始下一步。', true); }
    else clock();
  }, 1000);
  render();
})();
