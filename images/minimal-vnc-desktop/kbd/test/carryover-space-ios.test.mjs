// carryover-space-ios.test.mjs — the carry-over space guard on the iOS path.
//
// The guard lives in transport.js sendText, which BOTH platforms funnel through,
// but every test of it pinned an Android profile (see carryover-space.test.mjs).
// iOS reaches the same funnel by a different road — beforeinput carries the text
// instead of a value diff — and QuickType commits the word it was composing for
// the previous field on a field change exactly as Gboard does, so the defect the
// guard exists to stop is reachable here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, TAB } from './mock-rfb.mjs';

installGlobals('ios', { search: '?magnify=1' });

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

// Raise the keyboard the way a tap does — that is what arms the guard.
async function raised() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  return v;
}

const type = (proxy, data, inputType = 'insertText') => fire(proxy, 'beforeinput', { inputType, data });

test('the QuickType carry-over space never reaches a freshly raised field', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, ' ');
  assert.deepEqual(rfb.tapped(), [], 'the leading space is dropped on iOS too');
});

test('the first real character still goes through, and the guard then disarms', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, ' ');
  type(proxy, 'P');
  type(proxy, ' ');
  type(proxy, 'w');
  assert.deepEqual(rfb.tapped(), keysymsFor('P w'), 'only the LEADING space is removed');
});

test('a space leading a multi-char batch (dictation/paste commit) is dropped too', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, ' hello');
  assert.deepEqual(rfb.tapped(), keysymsFor('hello'));
});

test('a deliberate leading space survives once the window has passed', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, 'P');       // a real character disarms the guard
  rfb.clearKeys();
  type(proxy, ' ');
  assert.deepEqual(rfb.tapped(), keysymsFor(' '), 'a space the USER types is never touched');
});

test('Tab re-arms the guard, so the NEXT field is protected as well', async () => {
  const { rfb, proxy } = await raised();
  type(proxy, 'P');
  fire(proxy, 'keydown', { key: 'Tab' });
  rfb.clearKeys();
  type(proxy, ' ');
  assert.deepEqual(rfb.tapped().filter((k) => k !== TAB), [], 'the next field starts protected');
});
