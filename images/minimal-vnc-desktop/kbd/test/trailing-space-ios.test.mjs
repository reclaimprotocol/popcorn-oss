// trailing-space-ios.test.mjs — the address-field trailing-space repair on iOS.
//
// The repair lives in field-session.js and is driven by the REMOTE's sync signal,
// so nothing about it is Android-specific — but every test of it pinned an
// Android profile (see trailing-space.test.mjs), which left the iOS viewer's use
// of the same code unpinned. iOS raises the keyboard, latches a field and reads
// sync the same way, and its remote pages add the same trailing space, so the
// guards that keep the repair off passwords and prose have to hold here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, pushSignal, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb, BS } from './mock-rfb.mjs';

installGlobals('ios', { search: '?magnify=1' });

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };
const EMAIL_HINTS = {
  tag: 'INPUT', type: 'text', autoComplete: 'on', name: 'email',
  placeholder: 'Enter your email address or username',
};

async function raised() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  return v;
}

function signal(sync, hints, focusKey) {
  pushSignal({
    editable: true, focusKey: focusKey || 'f1', rect: FIELD_RECT,
    hints: hints || EMAIL_HINTS, sync, vw: 390, vh: 844, rects: [FIELD_RECT],
  });
}

test('an email field whose remote text ends in a space gets one Backspace', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ val: 'srivatsan@creatoros.co ', len: 23 });
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('no space, no repair', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ val: 'srivatsan@creatoros.co', len: 22 });
  assert.deepEqual(rfb.tapped(), []);
});

test('a password field is never repaired — a passphrase space is legal', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ sensitive: true, val: 'correct horse ', len: 14 },
    { tag: 'INPUT', type: 'password', name: 'password', autoComplete: 'current-password' }, 'pw');
  assert.deepEqual(rfb.tapped(), []);
});

test('a prose field keeps its trailing space', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ val: 'hello world ', len: 12 }, { tag: 'TEXTAREA', name: 'user_message' }, 'ta');
  assert.deepEqual(rfb.tapped(), []);
});
