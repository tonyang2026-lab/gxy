(function (root) {
  const empty = () => ({ tasks: [], activeId: null, deadline: null });
  function restore(value) {
    if (!value || !Array.isArray(value.tasks)) return empty();
    const ids = new Set();
    const tasks = value.tasks.filter(t => t && typeof t.id === 'string' && !ids.has(t.id) && ids.add(t.id) && typeof t.title === 'string' && t.title.trim() && Number.isInteger(t.minutes) && t.minutes >= 1 && t.minutes <= 480).slice(0, 100).map(t => ({ id: t.id, title: t.title.slice(0, 120), minutes: t.minutes, done: t.done === true, remaining: Number.isFinite(t.remaining) ? Math.max(0, Math.min(t.minutes * 60000, t.remaining)) : t.minutes * 60000 }));
    const active = tasks.find(t => t.id === value.activeId && !t.done);
    return { tasks, activeId: active ? active.id : null, deadline: active && Number.isFinite(value.deadline) ? value.deadline : null };
  }
  function change(state, action, now = Date.now()) {
    const next = restore(state);
    const active = next.tasks.find(t => t.id === next.activeId);
    function pause() { if (active && next.deadline !== null) active.remaining = Math.max(0, next.deadline - now); next.deadline = null; }
    const task = next.tasks.find(t => t.id === action.id);
    switch (action.type) {
      case 'add':
        if (next.tasks.length < 100 && typeof action.title === 'string' && action.title.trim() && Number.isInteger(action.minutes) && action.minutes >= 1 && action.minutes <= 480 && typeof action.id === 'string' && !task) next.tasks.push({ id: action.id, title: action.title.trim().slice(0, 120), minutes: action.minutes, done: false, remaining: action.minutes * 60000 });
        break;
      case 'start':
        if (task && !task.done) { pause(); next.activeId = task.id; next.deadline = now + task.remaining; }
        break;
      case 'pause': pause(); break;
      case 'tick':
        if (active && next.deadline !== null && now >= next.deadline) { active.remaining = 0; next.deadline = null; }
        break;
      case 'done':
        if (task) { task.done = !task.done; task.remaining = task.minutes * 60000; if (next.activeId === task.id) { next.activeId = null; next.deadline = null; } }
        break;
      case 'remove':
        next.tasks = next.tasks.filter(t => t.id !== action.id);
        if (next.activeId === action.id) { next.activeId = null; next.deadline = null; }
        break;
      case 'move': {
        const index = next.tasks.findIndex(t => t.id === action.id), target = index + action.direction;
        if (index >= 0 && [-1, 1].includes(action.direction) && target >= 0 && target < next.tasks.length) [next.tasks[index], next.tasks[target]] = [next.tasks[target], next.tasks[index]];
        break;
      }
      case 'restart':
        if (task && !task.done) { task.remaining = task.minutes * 60000; if (next.activeId === task.id) next.deadline = null; }
        break;
    }
    return next;
  }
  const api = { empty, restore, change };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Planner = api;
})(globalThis);
