const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updatePet } = require('../src/pet-state');
test('food and energy stay within bounds through repeated interactions', () => {
  let s = { hunger: 95, energy: 100, sleeping: false };
  s = updatePet(s, 'feed'); assert.equal(s.hunger, 100);
  for (let i = 0; i < 200; i++) s = updatePet(s, 'tick');
  assert.equal(s.hunger, 0); assert.equal(s.energy, 0);
  assert.deepEqual(updatePet(s, 'play'), s);
});
test('sleep restores energy and prevents feeding or play until awakened', () => {
  const s = { hunger: 50, energy: 98, sleeping: false };
  const sleeping = updatePet(s, 'sleep');
  assert.deepEqual(updatePet(sleeping, 'feed'), sleeping);
  assert.deepEqual(updatePet(sleeping, 'play'), sleeping);
  const rested = updatePet(sleeping, 'tick');
  assert.equal(rested.energy, 100); assert.equal(rested.hunger, 49);
  const awake = updatePet(rested, 'sleep');
  assert.equal(awake.sleeping, false);
  assert.equal(updatePet(awake, 'play').energy, 90);
  assert.equal(s.sleeping, false);
});
