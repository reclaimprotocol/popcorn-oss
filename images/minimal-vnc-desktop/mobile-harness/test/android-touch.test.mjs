// android-touch.test.mjs — the ADB transport's native touch payloads.
//
// Both properties here were paid for on a device. Android's `uinput` command
// rejects a payload by exiting non-zero with NOTHING on stdout or stderr — the
// reason goes to logcat — so a wrong payload reads as "unknown uinput error" and
// every pinch case failed that way:
//   No enum constant com.android.commands.uinput.Event.Bus.VIRTUAL
//   java.lang.IllegalStateException: Expected END_ARRAY but was END_OBJECT
// And `input swipe` cannot press-and-hold, so a long-press drag has to go through
// this payload instead — the hold has to survive as its own quantity to do that.
import assert from 'node:assert/strict';
import test from 'node:test';

import { androidMultiTouchPayload, pointerGestures } from '../src/android-touch.mjs';

const lines = (payload) => payload.trim().split('\n').map((line) => JSON.parse(line));
const register = (payload) => lines(payload).find((line) => line.command === 'register');

// What driver.performActions receives for a long-press drag (see nativeDrag).
function dragPointer({ holdMs = 200, steps = 4 } = {}) {
  const actions = [
    { type: 'pointerMove', duration: 0, x: 100, y: 200 },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: holdMs },
  ];
  for (let step = 1; step <= steps; step += 1) {
    actions.push({ type: 'pointerMove', duration: 20, x: 100, y: 200 + step * 25 });
  }
  actions.push({ type: 'pause', duration: 100 });
  actions.push({ type: 'pointerUp', button: 0 });
  return { type: 'pointer', id: 'finger', actions };
}

test('every code on the wire is numeric — uinput has no names', () => {
  const payload = androidMultiTouchPayload(
    [{ fromX: 100, fromY: 200, toX: 300, toY: 400, durationMs: 400, holdMs: 0 }],
    1080, 2400,
  );
  for (const line of lines(payload)) {
    if (line.command === 'register') {
      for (const entry of line.configuration) {
        assert.equal(typeof entry.type, 'number', 'configuration type');
        for (const value of entry.data) assert.equal(typeof value, 'number', 'configuration data');
      }
      for (const entry of line.abs_info) assert.equal(typeof entry.code, 'number', 'abs_info code');
    }
    if (line.command === 'inject') {
      for (const value of line.events) assert.equal(typeof value, 'number', 'injected event value');
    }
  }
});

test('the bus is one the tool actually has an enum constant for', () => {
  const payload = androidMultiTouchPayload([{ fromX: 1, fromY: 1, toX: 2, toY: 2 }], 1080, 2400);
  // Event.Bus in AOSP: USB, BLUETOOTH. 'virtual' threw and took the pinch with it.
  assert.ok(['usb', 'bluetooth'].includes(register(payload).bus));
});

test('a press-and-hold is kept apart from the movement duration', () => {
  const [gesture] = pointerGestures(dragPointer({ holdMs: 200, steps: 4 }));
  assert.equal(gesture.holdMs, 200, 'the pause before the first move is the hold');
  // 4 moves x 20ms, plus the 100ms release pause once movement has started.
  assert.equal(gesture.durationMs, 4 * 20 + 100, 'and does not inflate the movement');
});

test('the hold reaches the wire as a delay between the press and the first move', () => {
  const [gesture] = pointerGestures(dragPointer({ holdMs: 250 }));
  const seq = lines(androidMultiTouchPayload([gesture], 1080, 2400));
  const firstInject = seq.findIndex((line) => line.command === 'inject');
  const delayAfterPress = seq[firstInject + 1];
  assert.equal(delayAfterPress.command, 'delay');
  assert.equal(delayAfterPress.duration, 250, 'the page gets its long press');
});

test('a plain swipe carries no hold, so it keeps the fast input path', () => {
  const pointer = {
    type: 'pointer',
    id: 'finger',
    actions: [
      { type: 'pointerMove', duration: 0, x: 10, y: 20 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 300, x: 10, y: 400 },
      { type: 'pointerUp', button: 0 },
    ],
  };
  const [gesture] = pointerGestures(pointer);
  assert.equal(gesture.holdMs, 0);
  assert.equal(gesture.durationMs, 300);
});

test('two fingers get their own slots and tracking ids', () => {
  const payload = androidMultiTouchPayload([
    { fromX: 300, fromY: 1200, toX: 100, toY: 1000, durationMs: 400 },
    { fromX: 700, fromY: 1200, toX: 900, toY: 1400, durationMs: 400 },
  ], 1080, 2400);
  const start = lines(payload).find((line) => line.command === 'inject');
  const SLOT = 47, TRACKING_ID = 57, EV_ABS = 3;
  const slots = [];
  for (let i = 0; i + 2 < start.events.length; i += 3) {
    if (start.events[i] === EV_ABS && start.events[i + 1] === SLOT) slots.push(start.events[i + 2]);
  }
  assert.deepEqual(slots, [0, 1], 'one slot per finger');
  const ids = [];
  for (let i = 0; i + 2 < start.events.length; i += 3) {
    if (start.events[i] === EV_ABS && start.events[i + 1] === TRACKING_ID) ids.push(start.events[i + 2]);
  }
  assert.deepEqual(ids, [100, 101], 'distinct tracking ids, or the two fingers merge');
});
