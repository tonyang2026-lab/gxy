const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/amazon-templates');
const P = require('../src/planner-state');
let id = 0; const makeId = () => `task-${id++}`;
test('all six templates add valid unrewarded tasks without changing existing plan', () => {
  let p = P.empty();
  for (const t of A.templates) {
    const priorLength = p.tasks.length;
    const r = A.append(p, t.id, makeId);
    assert.equal(p.tasks.length, priorLength);
    assert.equal(r.added, t.tasks.length);
    assert.deepEqual(P.restore(r.plan), r.plan);
    assert.ok(r.plan.tasks.every(task => !task.done && !task.rewarded && !task.food));
    p = r.plan;
  }
  assert.equal(p.tasks.length, 43);
});
test('repeat import skips unfinished tasks and permits next cycle after completion', () => {
  const first = A.append(P.empty(), 'daily', makeId);
  const duplicate = A.append(first.plan, 'daily', makeId);
  assert.equal(duplicate.added, 0); assert.equal(duplicate.duplicates, first.added);
  const completed = P.change(first.plan, { type: 'done', id: first.plan.tasks[0].id }, () => 0).plan;
  const next = A.append(completed, 'daily', makeId);
  assert.equal(next.added, 1);
  assert.equal(next.plan.tasks[0].food, '小饼干');
  assert.notEqual(next.plan.tasks.at(-1).id, next.plan.tasks[0].id);
});
test('capacity and unknown templates preserve existing work and report omitted tasks', () => {
  const tasks = Array.from({ length: 99 }, (_, i) => ({ id: `old-${i}`, title: `原任务${i}`, done: false, rewarded: false, food: null }));
  const r = A.append({ tasks }, 'daily', makeId);
  assert.equal(r.added, 1); assert.equal(r.overflow, 6); assert.equal(r.plan.tasks.length, 100);
  assert.deepEqual(r.plan.tasks.slice(0, 99), tasks);
  assert.equal(A.append(r.plan, 'unknown', makeId).added, 0);
});
