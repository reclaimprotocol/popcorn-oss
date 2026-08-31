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

test('platform coordinates are applied before target-specific calibration', () => {
  const actions = [{
    type: 'tap',
    name: 'type-q',
    x: 23,
    y: 613,
    platformOverrides: { Android: { x: 60, y: 1715 } },
    targetOverrides: { candidate: { y: 1700 } },
  }];

  assert.deepEqual(actionsForTarget(actions, 'baseline', 'Android'), [
    { type: 'tap', name: 'type-q', x: 60, y: 1715 },
  ]);
  assert.deepEqual(actionsForTarget(actions, 'candidate', 'Android'), [
    { type: 'tap', name: 'type-q', x: 60, y: 1700 },
  ]);
  assert.deepEqual(actionsForTarget(actions, 'baseline', 'iOS'), [
    { type: 'tap', name: 'type-q', x: 23, y: 613 },
  ]);
});

test('environment coordinate scale maps shared mobile actions to the Android screen', () => {
  const actions = [{
    type: 'swipe', name: 'scroll', fromX: 200, fromY: 700, toX: 200, toY: 320,
  }];

  assert.deepEqual(actionsForTarget(actions, 'baseline', 'Android', { x: 1080 / 393, y: 2400 / 852 }), [
    { type: 'swipe', name: 'scroll', fromX: 550, fromY: 1972, toX: 550, toY: 901 },
  ]);
});

test('platform-target override can replace a tap with a calibrated native swipe', () => {
  const actions = [{
    type: 'tap', name: 'choose-month', x: 128, y: 429,
    platformOverrides: { Android: { x: 410, y: 1085 } },
    platformTargetOverrides: { Android: { baseline: {
      type: 'swipe', fromX: 410, fromY: 1145, toX: 410, toY: 1015, durationMs: 450,
    } } },
  }];

  assert.deepEqual(actionsForTarget(actions, 'baseline', 'Android', { x: 2, y: 3 }), [{
    type: 'swipe', name: 'choose-month', x: 410, y: 1085,
    fromX: 410, fromY: 1145, toX: 410, toY: 1015, durationMs: 450,
  }]);
  assert.deepEqual(actionsForTarget(actions, 'candidate', 'Android', { x: 2, y: 3 }), [{
    type: 'tap', name: 'choose-month', x: 410, y: 1085,
  }]);
});

test('an action can be limited to the platform whose control it describes', () => {
  const actions = [
    { type: 'waitForColor', name: 'ready', color: '#2b005f' },
    { type: 'tapNativeElement', name: 'step-day', platforms: ['Android'], android: { text: '24' } },
    { type: 'tapNativeElement', name: 'set-wheel', platforms: ['iOS'], ios: { pickerValue: '29' } },
  ];
  const android = actionsForTarget(actions, 'baseline', 'Android');
  const ios = actionsForTarget(actions, 'baseline', 'iOS');
  assert.deepEqual(android.map((a) => a.name), ['ready', 'step-day']);
  assert.deepEqual(ios.map((a) => a.name), ['ready', 'set-wheel']);
  // The marker must not leak into the action the driver executes.
  assert.ok(!('platforms' in android[1]));
});

test('an empty or malformed platforms list is a case error, not a silent skip', () => {
  assert.throws(() => actionsForTarget([{ type: 'tap', name: 'x', platforms: [] }], 'baseline', 'iOS'),
    /invalid platforms list/);
  assert.throws(() => actionsForTarget([{ type: 'tap', name: 'x', platforms: 'iOS' }], 'baseline', 'iOS'),
    /invalid platforms list/);
});
