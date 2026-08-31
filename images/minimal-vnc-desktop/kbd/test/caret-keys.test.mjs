// caret-keys.test.mjs — keyboards that ship a caret on a phone.
//
// Hacker's Keyboard (and several third-party layouts) give the user arrows,
// Home/End and Delete. Those used to be swallowed on the mobile proxy: the local
// caret moved, the remote's did not, and the next edit diffed against a tail the
// remote was no longer writing behind — silent corruption with no way back.
//
// Forwarding is only half of it. The value-diff is anchored to the END of the
// field, so the baseline has to be dropped with the caret move; the characters
// after it then go out as plain inserts at the position both sides now share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-input');

const LEFT = 0xff51, RIGHT = 0xff53, UP = 0xff52, DOWN = 0xff54;
const HOME = 0xff50, END = 0xff57, DEL = 0xffff;
const RECT = { x: 0, y: 0, w: 10, h: 10 };

function focusField() {
  pushSignal({ editable: true, focusKey: 'f1', rect: RECT,
    hints: { tag: 'INPUT', type: 'text' }, sync: { sensitive: false, len: 0 } });
}
function type(proxy, value) {
  proxy.value = value;
  fire(proxy, 'input', { inputType: 'insertText' });
}

test('every caret key reaches the remote', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField();
  rfb.clearKeys();
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Delete']) {
    const e = fire(proxy, 'keydown', { key });
    assert.equal(e.defaultPrevented, true, key + ' should be consumed by the proxy');
  }
  assert.deepEqual(rfb.tapped(), [LEFT, RIGHT, UP, DOWN, HOME, END, DEL]);
});

test('a caret move drops the diff baseline so the next insert is not a rewrite', async () => {
  // The bug this exists to prevent: with the baseline kept, typing after a Left
  // backspaces the tail the remote caret has already moved off, eating characters
  // the user never touched.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField();
  type(proxy, 'helo');
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'ArrowLeft' });
  assert.equal(proxy.value, '', 'the local buffer goes with the caret');
  type(proxy, 'l');
  assert.deepEqual(rfb.tapped(), [LEFT, ...keysymsFor('l')], 'a plain insert, no backspaces');
});

test('a caret key while composing belongs to the IME, not the remote', async () => {
  // Arrows move through the candidate window mid-composition; forwarding them
  // would fire the remote page while the word is still being chosen.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField();
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'ArrowLeft', isComposing: true, keyCode: 229 });
  assert.deepEqual(rfb.tapped(), []);
});
