(() => {
  const get = id => document.getElementById(id);
  let plan = Planner.empty();
  try { plan = Planner.restore(JSON.parse(localStorage.getItem('xiaoxing-workflow'))); } catch { /* Start with an empty plan. */ }
  function save() { try { localStorage.setItem('xiaoxing-workflow', JSON.stringify(plan)); } catch { get('plan-status').textContent = '本地保存失败，请勿关闭窗口，以免丢失计划。'; } }
  function dispatch(action) {
    const result = Planner.change(plan, action); plan = result.plan;
    renderPlan(); save();
    if (result.reward) {
      const food = result.reward;
      state = { ...state, hunger: Math.min(100, state.hunger + food.nutrition) };
      render();
      get('food-reward').textContent = `任务完成！随机投喂 ${food.emoji} ${food.name}，饱食 +${food.nutrition}（上限100）`;
      say(`辛苦啦！我们吃到了${food.name}，谢谢你！`, true);
    }
  }
  function button(text, label, action, disabled = false) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', label); b.disabled = disabled; b.onclick = () => dispatch(action); return b;
  }
  function renderPlan() {
    const done = plan.tasks.filter(t => t.done).length;
    const unfinished = plan.tasks.filter(t => !t.done);
    get('plan-progress').textContent = `${done}/${plan.tasks.length} 已完成`;
    get('plan-next').textContent = unfinished.length ? `接下来：${unfinished[0].title}` : plan.tasks.length ? '全部完成啦，辛苦了！' : '把今天的工作拆成几个小步骤吧。';
    get('task-list').replaceChildren();
    plan.tasks.forEach((t, index) => {
      const row = document.createElement('li'); row.className = `task${t.done ? ' completed' : ''}`;
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = t.done; check.setAttribute('aria-label', `完成：${t.title}`); check.onchange = () => dispatch({ type: 'done', id: t.id });
      const text = document.createElement('span'); text.className = 'task-title'; text.textContent = `${index + 1}. ${t.title}`;
      const controls = document.createElement('div'); controls.className = 'task-controls';
      controls.append(button('↑', `上移 ${t.title}`, { type: 'move', id: t.id, direction: -1 }, index === 0), button('↓', `下移 ${t.title}`, { type: 'move', id: t.id, direction: 1 }, index === plan.tasks.length - 1));
      if (t.food) { const badge = document.createElement('span'); badge.className = 'food-badge'; badge.textContent = `已喂 ${Planner.foods.find(f => f.name === t.food).emoji} ${t.food}`; controls.append(badge); }
      controls.append(button('删除', `删除 ${t.title}`, { type: 'remove', id: t.id }));
      row.append(check, text, controls); get('task-list').append(row);
    });
  }
  get('task-form').onsubmit = e => {
    e.preventDefault();
    if (plan.tasks.length >= 100) { get('plan-status').textContent = '最多保存 100 个步骤，请先删除不需要的任务。'; return; }
    dispatch({ type: 'add', id: crypto.randomUUID(), title: get('task-title').value }); get('task-title').value = ''; get('task-title').focus();
  };
  renderPlan();
})();
