const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/scheduler');
const config = { date: '2026-10-20', start: '09:00', end: '18:00', lunch: true, lunchStart: '12:00', lunchEnd: '13:00' };
const now = new Date(2026, 9, 19, 10);
const task = (id, duration, extra = {}) => ({ id, title: id, duration, priority: 1, ...extra });
test('deadlines sort before priority and equal tasks retain input order', () => {
  const result = S.schedule([task('low', 30), task('high', 30, { priority: 2 }), task('due', 30, { deadline: '10:00' }), task('equal', 30)], config, now);
  assert.deepEqual(result.entries.map(e => e.id), ['due', 'high', 'low', 'equal']);
});
test('splits around lunch and lists tasks that cannot fit without taking their partial time', () => {
  const result = S.schedule([task('long', 240), task('tooLong', 480), task('small', 30)], config, now);
  assert.deepEqual(result.entries[0].segments, [{ start: 540, end: 720 }, { start: 780, end: 840 }]);
  assert.equal(result.unscheduled[0].id, 'tooLong'); assert.equal(result.entries[1].segments[0].start, 840);
});
test('today begins after current minute and flags missed deadlines, excludes completed', () => {
  const result = S.schedule([task('late', 30, { deadline: '09:00' }), task('done', 30, { done: true })], config, new Date(2026, 9, 20, 10, 12, 1));
  assert.equal(result.entries[0].segments[0].start, 613); assert.equal(result.entries[0].late, true); assert.equal(result.entries.length, 1);
});
test('after working hours leaves tasks unscheduled; optional lunch and invalid settings', () => {
  assert.equal(S.schedule([task('a', 10)], config, new Date(2026, 9, 20, 19)).unscheduled.length, 1);
  const result = S.schedule([task('a', 240)], { ...config, lunch: false }, now);
  assert.deepEqual(result.entries[0].segments, [{ start: 540, end: 780 }]);
  assert.throws(() => S.schedule([], { ...config, end: '08:00' }, now), /工作/);
  assert.throws(() => S.schedule([], { ...config, date: '2026-02-31' }, now), /日期/);
  assert.throws(() => S.schedule([], { ...config, lunchEnd: '10:00' }, now), /午休/);
  assert.throws(() => S.schedule([task('bad', 0)], config, now), /用时/);
});
