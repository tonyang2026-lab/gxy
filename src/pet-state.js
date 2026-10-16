function updatePet(state, action) {
  const next = { ...state };
  const clamp = value => Math.max(0, Math.min(100, value));
  if (action === 'sleep') next.sleeping = !state.sleeping;
  if (action === 'tick') {
    next.hunger = clamp(state.hunger - 1);
    next.energy = clamp(state.energy + (state.sleeping ? 5 : -1));
  }
  if (!state.sleeping && action === 'feed') next.hunger = clamp(state.hunger + 20);
  if (!state.sleeping && action === 'play' && state.energy >= 10) {
    next.energy = clamp(state.energy - 10);
    next.hunger = clamp(state.hunger - 5);
  }
  return next;
}
if (typeof module !== 'undefined') module.exports = { updatePet };
