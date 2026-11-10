const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PetState } = require('../src/pet-state.cjs');
function fixture() {
  const output = [], timers = new Map(); let index = 0, busy = false;
  const state = new PetState(value => output.push(value), () => busy, {
    setTimer: fn => { timers.set(++index, fn); return index; }, clearTimer: id => timers.delete(id),
  });
  return { state, output, busy: value => { busy = value; state.refresh(); },
    fire: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }, timers };
}
test('DSH is disabled by default and repeated equivalent events emit once', () => {
  const f = fixture(); f.state.enable(false); f.state.external({ state: 'running', bubble: 'DSH' });
  assert.equal(f.output.length, 0);
  f.state.enable(true); f.state.external({ state: 'running', bubble: 'DSH' });
  assert.equal(f.output.length, 1);
});
test('chat and interaction timers return to the latest DSH state', () => {
  const f = fixture(); f.state.enable(true); f.state.external({ state: 'running' });
  f.busy(true); f.state.local('running', 'local');
  f.state.interact('waving', 'hello'); assert.equal(f.output.at(-1).state, 'running');
  f.state.external({ state: 'waiting' }); f.state.local('review', 'done', 3200); f.busy(false);
  assert.equal(f.output.at(-1).state, 'waving');
  f.fire(); assert.equal(f.output.at(-1).state, 'waiting');
});
test('repeated interactions cancel old deadlines; disabling clears DSH bubble', () => {
  const f = fixture(); f.state.enable(true); f.state.external({ state: 'waiting', bubble: 'DSH' });
  f.state.interact('waving', 'one'); f.state.interact('jumping', 'two');
  assert.equal(f.timers.size, 1); f.fire(); assert.equal(f.output.at(-1).state, 'waiting');
  f.state.enable(false); assert.equal(f.output.at(-1).state, 'idle'); assert.equal(f.output.at(-1).clearBubble, true);
  f.state.dispose(); assert.equal(f.timers.size, 0);
});
test('turning off DSH bubbles clears the current bubble without repeating it', () => {
  const f = fixture(); f.state.enable(true); f.state.external({ state: 'running', bubble: 'DSH' });
  f.state.external({ state: 'running' }); assert.equal(f.output.at(-1).clearBubble, true);
  const count = f.output.length; f.state.external({ state: 'running' }); assert.equal(f.output.length, count);
});
test('a new local request cancels an older completion reset', () => {
  const f = fixture(); f.state.enable(true); f.state.local('review', 'done', 3200);
  f.state.local('running', 'next'); assert.equal(f.timers.size, 0);
  f.fire(); assert.equal(f.output.at(-1).state, 'running');
});
test('disabling DSH during an interaction preserves its remaining animation', () => {
  const f = fixture(); f.state.enable(true); f.state.external({ state: 'waiting' });
  f.state.interact('waving', 'hello'); f.state.enable(false);
  assert.equal(f.output.at(-1).state, 'waving');
  f.fire(); assert.equal(f.output.at(-1).state, 'idle');
});
