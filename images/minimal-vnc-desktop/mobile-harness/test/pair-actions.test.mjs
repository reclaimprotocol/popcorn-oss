import assert from 'node:assert/strict';
import test from 'node:test';

import { actionsForTarget } from '../src/pair-actions.mjs';

test('target overrides calibrate coordinates without changing the shared semantic action', () => {
  const actions = [{
    type: 'tap',
    name: 'choose-business',
    x: 0,
    y: 0,
    targetOverrides: {
      baseline: { x: 200, y: 320 },
      candidate: { x: 80, y: 696 },
    },
  }];

  assert.deepEqual(actionsForTarget(actions, 'baseline'), [
    { type: 'tap', name: 'choose-business', x: 200, y: 320 },
  ]);
  assert.deepEqual(actionsForTarget(actions, 'candidate'), [
    { type: 'tap', name: 'choose-business', x: 80, y: 696 },
  ]);
  assert.equal(actions[0].targetOverrides.candidate.y, 696);
});

test('target overrides cannot change action identity', () => {
  assert.throws(
    () => actionsForTarget([{ type: 'tap', name: 'same', targetOverrides: { candidate: { type: 'swipe' } } }], 'candidate'),
    /cannot change type or name/,
  );
});
