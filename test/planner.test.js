const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/planner-state');
function add(p, id = 'a') { return P.change(p, { type: 'add', id, title: `任务${id}` }).plan; }
test('completion randomly rewards food exactly once, including after restoring', () => {
  let result = P.change(add(P.empty()), { type: 'done', id: 'a' }, () => 0);
  assert.equal(result.reward.name, '小饼干'); assert.equal(result.plan.tasks[0].done, true);
  let p = P.restore(JSON.parse(JSON.stringify(result.plan)));
  p = P.change(p, { type: 'done', id: 'a' }).plan;
  result = P.change(p, { type: 'done', id: 'a' });
  assert.equal(result.reward, null); assert.equal(result.plan.tasks[0].food, '小饼干');
});
test('food selection covers every food and tasks reward independently', () => {
  let p = P.empty();
  P.foods.forEach((food, i) => {
    p = add(p, String(i));
    const r = P.change(p, { type: 'done', id: String(i) }, () => (i + .5) / P.foods.length);
    assert.equal(r.reward.name, food.name); p = r.plan;
  });
});
test('old timed plans migrate without granting rewards for already completed tasks', () => {
  const p = P.restore({ tasks: [{ id: 'a', title: '旧任务', minutes: 25, done: true }], activeId: 'a', deadline: 10000 });
  assert.equal(p.deadline, undefined);
  const reopened = P.change(p, { type: 'done', id: 'a' }).plan;
  assert.equal(P.change(reopened, { type: 'done', id: 'a' }).reward, null);
});
test('reordering and invalid input do not grant food', () => {
  let p = add(add(P.empty()), 'b');
  let r = P.change(p, { type: 'move', id: 'b', direction: -1 });
  assert.equal(r.plan.tasks[0].id, 'b'); assert.equal(r.reward, null);
  r = P.change(r.plan, { type: 'add', id: 'x', title: ' ' }); assert.equal(r.plan.tasks.length, 2);
  r = P.change(r.plan, { type: 'remove', id: 'a' }); assert.equal(r.plan.tasks.length, 1);
  assert.deepEqual(P.restore({ tasks: [null, {}] }), P.empty());
});
