// carryover-space.test.mjs — characterization: the carry-over space guard.
//
// Moving username -> password put a SPACE in the password before the first typed
// character, so a correct login was rejected ("incorrect email or password") —
// which reads as an email problem and is what misdirected the earlier hunt.
//
// Tapping the next field makes Gboard commit the word it was still composing for
// the PREVIOUS one, and that commit (word + auto-space) arrives after the remote
// has moved focus. Neither existing defence stops it: the address-field filter is
// deliberately off on a password (passphrase spaces are legal), and the
// cross-field buffer reset is keyed on focusKey changing, which the device log
// shows constant across both fields.
//
// So the guard is a local invariant at the send funnel: the FIRST character of a
// fresh field session is never a space. These tests pin both halves — the space
// is dropped when leading, and untouched everywhere else (a passphrase with
// spaces has to keep working).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal, fireDoc, makeScreen, advanceClock } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, TAB } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

function type(proxy, newValue, inputType) {
  proxy.value = newValue;
  return fire(proxy, 'input', { inputType: inputType || 'insertText' });
}

// Raise the keyboard the way a tap does — that's what arms the guard.
async function raised() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  return v;
}

test('the IME carry-over space never reaches a freshly raised field', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, ' '); // Gboard flushes the previous field's pending auto-space
  assert.deepEqual(rfb.tapped(), [], 'the space that broke the password login is dropped');
});

test('the first real character still goes through, and the guard then disarms', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, ' ');       // dropped
  type(proxy, ' P');      // 'P' is the first real char
  type(proxy, ' P ');     // a space AFTER it is legitimate — passphrases have spaces
  type(proxy, ' P w');
  assert.deepEqual(rfb.tapped(), keysymsFor('P w'), 'only the LEADING space is removed');
});

test('a passphrase with interior spaces is untouched', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, 'correct');
  type(proxy, 'correct horse battery');
  assert.deepEqual(rfb.tapped(), keysymsFor('correct horse battery'));
});

test('a space leading a multi-char batch (glide/voice commit) is dropped too', async () => {
  // The carry-over can arrive fused to the next word rather than alone.
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  type(proxy, ' hunter2');
  assert.deepEqual(rfb.tapped(), keysymsFor('hunter2'));
});

test('Tab re-arms the guard, so the NEXT field is protected as well', async () => {
  const { rfb, proxy } = await raised();
  type(proxy, 'user');           // disarms
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Tab' }); // move to the password field
  type(proxy, ' ');              // the carry-over lands in the new field
  type(proxy, ' s');
  assert.deepEqual(rfb.tapped(), [TAB].concat(keysymsFor('s')),
    'tabbing between fields is the same hazard as tapping into them');
});

test('after real typing, a space the USER types is never touched', async () => {
  // Scope boundary: once a real character has gone out, the guard is done. A space
  // typed after deleting back to empty belongs to the user, not to the IME's
  // cross-field carry-over, so it must survive.
  const { rfb, proxy } = await raised();
  type(proxy, 'x');
  rfb.clearKeys();
  type(proxy, '', 'deleteContentBackward'); // back to empty
  type(proxy, ' ');
  assert.deepEqual(rfb.tapped().slice(-1), keysymsFor(' '));
});

test('Enter does NOT re-arm the guard — a textarea newline is not a field change', async () => {
  // Re-arming on Enter would drop the first space of every new line, silently
  // eating indentation in a multi-line field. Tab is the field change; Enter isn't.
  const { rfb, proxy } = await raised();
  type(proxy, 'a');                       // disarms
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Enter' }); // newline / action key
  type(proxy, ' b');
  assert.deepEqual(rfb.tapped().slice(-2), keysymsFor(' b'), 'the indent space survives');
});

// ---- the sensitive-field limits ---------------------------------------------
// A password can legitimately START with a space. Stripping it produces a failed
// login with NO feedback (invisible field, drift-recon off on secrets) — the same
// class of undebuggable bug this guard exists to fix, so the guard is bounded to
// the machine-fast window the IME's cross-field flush actually lands in.

test('a DELIBERATE leading space survives — it arrives after the carry-over window', async () => {
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  advanceClock(1500); // user tapped the field, keyboard animated up, then pressed space
  type(proxy, ' ');
  type(proxy, ' s');
  assert.deepEqual(rfb.tapped(), keysymsFor(' s'),
    'a password beginning with a space must reach the remote intact');
});

test('a leading space inside the window is still dropped', async () => {
  // The boundary in the other direction: the IME flush is instantaneous.
  const { rfb, proxy } = await raised();
  rfb.clearKeys();
  advanceClock(100);
  type(proxy, ' ');
  assert.deepEqual(rfb.tapped(), []);
});
