import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWindowFractions, usesWindowFractions } from '../src/window-fractions.mjs';

const IOS = { width: 390, height: 844 };
const ANDROID = { width: 1080, height: 2400 };

test('a fraction resolves to the same place on every window', () => {
  const action = { type: 'swipe', fromYFraction: 0.65, toYFraction: 0.25, fromXFraction: 0.5, toXFraction: 0.5 };
  const ios = resolveWindowFractions(action, IOS);
  const android = resolveWindowFractions(action, ANDROID);
  assert.deepEqual({ fromX: ios.fromX, fromY: ios.fromY, toX: ios.toX, toY: ios.toY },
    { fromX: 195, fromY: 549, toX: 195, toY: 211 });
  assert.deepEqual({ fromX: android.fromX, fromY: android.fromY, toX: android.toX, toY: android.toY },
    { fromX: 540, fromY: 1560, toX: 540, toY: 600 });
  // Same relative position on both, to within the rounding to whole pixels.
  assert.ok(Math.abs(ios.fromY / IOS.height - android.fromY / ANDROID.height) < 0.001);
});

test('fraction fields are consumed, not passed through to the driver', () => {
  const resolved = resolveWindowFractions({ fromYFraction: 0.5, durationMs: 700 }, IOS);
  assert.equal(resolved.fromY, 422);
  assert.ok(!('fromYFraction' in resolved), 'the fraction must not reach performActions');
  assert.equal(resolved.durationMs, 700, 'unrelated fields survive');
});

test('absolute coordinates keep working alongside', () => {
  const resolved = resolveWindowFractions({ fromX: 200, fromY: 500, toX: 200, toY: 180 }, ANDROID);
  assert.deepEqual(resolved, { fromX: 200, fromY: 500, toX: 200, toY: 180 });
  assert.equal(usesWindowFractions({ fromX: 200 }), false);
  assert.equal(usesWindowFractions({ fromYFraction: 0.6 }), true);
});

test('a fraction outside 0..1 fails before the gesture runs', () => {
  // Silently clamping would run a gesture the case did not describe.
  assert.throws(() => resolveWindowFractions({ fromYFraction: 1.5 }, IOS), /between 0 and 1/);
  assert.throws(() => resolveWindowFractions({ fromYFraction: -0.1 }, IOS), /between 0 and 1/);
  assert.throws(() => resolveWindowFractions({ fromYFraction: 'half' }, IOS), /between 0 and 1/);
  assert.throws(() => resolveWindowFractions({ fromYFraction: 0.5 }, { width: 390 }), /window height/);
});

test('fraction 0 is honoured rather than treated as missing', () => {
  const resolved = resolveWindowFractions({ fromYFraction: 0, toYFraction: 1 }, IOS);
  assert.equal(resolved.fromY, 0);
  assert.equal(resolved.toY, 844);
});
