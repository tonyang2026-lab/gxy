const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/planner-state');
function plan() { let p = P.empty(); for (const id of ['a', 'b']) p = P.change(p, { type: 'add', id, title: id, minutes: 1 }, 0); return p; }
test('switching tasks preserves time, expiration requires explicit completion', () => {
  let p = P.change(plan(), { type: 'start', id: 'a' }, 1000);
  p = P.change(p, { type: 'start', id: 'b' }, 11000);
  assert.equal(p.tasks[0].remaining, 50000);
  p = P.change(p, { type: 'tick' }, 71000);
  assert.equal(p.tasks[1].remaining, 0); assert.equal(p.tasks[1].done, false); assert.equal(p.deadline, null);
  p = P.change(p, { type: 'done', id: 'b' }); assert.equal(p.activeId, null); assert.equal(p.tasks[1].done, true);
});
test('paused and restored running plans retain progress across sessions', () => {
  let p = P.change(plan(), { type: 'start', id: 'a' }, 1000);
  p = P.restore(JSON.parse(JSON.stringify(p)));
  assert.equal(p.deadline, 61000);
  p = P.change(p, { type: 'pause' }, 21000); assert.equal(p.tasks[0].remaining, 40000);
  p = P.change(p, { type: 'start', id: 'a' }, 30000); assert.equal(p.deadline, 70000);
  p = P.change(p, { type: 'remove', id: 'a' }); assert.equal(p.deadline, null); assert.equal(p.activeId, null);
});
test('reorder, validation, reset and undo completion', () => {
  let p = plan();
  p = P.change(p, { type: 'add', id: 'x', title: ' ', minutes: 0 }); assert.equal(p.tasks.length, 2);
  p = P.change(p, { type: 'move', id: 'b', direction: -1 }); assert.equal(p.tasks[0].id, 'b');
  p = P.change(p, { type: 'start', id: 'b' }, 0);
  p = P.change(p, { type: 'restart', id: 'b' }, 10000); assert.equal(p.deadline, null); assert.equal(p.tasks[0].remaining, 60000);
  p = P.change(p, { type: 'done', id: 'b' }); p = P.change(p, { type: 'done', id: 'b' }); assert.equal(p.tasks[0].done, false);
  assert.deepEqual(P.restore({ tasks: [null, { id: 'bad' }] }), P.empty());
});
