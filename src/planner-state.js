(function (root) {
  const foods = [
    { name: '小饼干', emoji: '🍪', nutrition: 8 },
    { name: '草莓', emoji: '🍓', nutrition: 10 },
    { name: '苹果', emoji: '🍎', nutrition: 12 },
    { name: '小蛋糕', emoji: '🍰', nutrition: 15 },
    { name: '饭团', emoji: '🍙', nutrition: 18 }
  ];
  const empty = () => ({ tasks: [] });
  function restore(value) {
    if (!value || !Array.isArray(value.tasks)) return empty();
    const ids = new Set();
    return { tasks: value.tasks.filter(t => t && typeof t.id === 'string' && !ids.has(t.id) && ids.add(t.id) && typeof t.title === 'string' && t.title.trim()).slice(0, 100).map(t => ({ id: t.id, title: t.title.slice(0, 120), done: t.done === true, rewarded: t.rewarded === true || t.done === true, food: foods.some(f => f.name === t.food) ? t.food : null })) };
  }
  function change(state, action, random = Math.random) {
    const next = restore(state);
    const task = next.tasks.find(t => t.id === action.id);
    let reward = null;
    switch (action.type) {
      case 'add':
        if (next.tasks.length < 100 && typeof action.title === 'string' && action.title.trim() && typeof action.id === 'string' && !task) next.tasks.push({ id: action.id, title: action.title.trim().slice(0, 120), done: false, rewarded: false, food: null });
        break;
      case 'done':
        if (task) {
          task.done = !task.done;
          if (task.done && !task.rewarded) {
            reward = foods[Math.min(foods.length - 1, Math.max(0, Math.floor(random() * foods.length)))];
            task.rewarded = true; task.food = reward.name;
          }
        }
        break;
      case 'remove': next.tasks = next.tasks.filter(t => t.id !== action.id); break;
      case 'move': {
        const index = next.tasks.findIndex(t => t.id === action.id), target = index + action.direction;
        if (index >= 0 && [-1, 1].includes(action.direction) && target >= 0 && target < next.tasks.length) [next.tasks[index], next.tasks[target]] = [next.tasks[target], next.tasks[index]];
        break;
      }
    }
    return { plan: next, reward };
  }
  const api = { empty, restore, change, foods };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Planner = api;
})(globalThis);
