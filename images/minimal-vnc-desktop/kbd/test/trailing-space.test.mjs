// trailing-space.test.mjs — characterization: address-field trailing-space repair.
//
// Tapping a Gboard suggestion in an email/username field commits the word PLUS a
// trailing space. Instrumentation proved no send path of ours ever carries that
// space (every one funnels through transport.sendText, which already drops it on
// these fields) — the REMOTE page's IME/autofill adds it. So the repair reads the
// only authoritative source, sync.val, and sends a Backspace when an
// address-class field's real text ends in a space.
//
// These pin the guards as much as the behaviour: the repair must never fire on a
// password (passphrase spaces are legal), on prose, mid-composition, or on a
// field we don't own — and it must be bounded so a page that re-adds the space
// can't turn it into a backspace loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, pushSignal, fireDoc, makeScreen, advanceClock } from './stub-dom.mjs';
import { createMockRfb, BS } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };
// Kaggle's sign-in field, verbatim: type says nothing, autocomplete says nothing,
// `name` is the only attribute that identifies it.
const EMAIL_HINTS = {
  tag: 'INPUT', type: 'text', autoComplete: 'on', name: 'email',
  placeholder: 'Enter your email address or username',
};

// Tap-raise so the keyboard latches (the repair only touches a field we own).
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
  assert.deepEqual(rfb.tapped(), [BS], 'the invisible space that failed the login is removed');
});

test('no space, no repair — the common case sends nothing', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ val: 'srivatsan@creatoros.co', len: 22 });
  assert.deepEqual(rfb.tapped(), []);
});

test('a space in the MIDDLE is left alone (only the trailing one is provably wrong)', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ val: 'sri vatsan', len: 10 });
  assert.deepEqual(rfb.tapped(), []);
});

test('a password field is never repaired — a passphrase space is legal', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ sensitive: true, val: 'correct horse ', len: 14 },
    { tag: 'INPUT', type: 'password', name: 'password', autoComplete: 'current-password' }, 'pw');
  assert.deepEqual(rfb.tapped(), [], 'and a sensitive field publishes no val anyway');
});

test('a prose field keeps its trailing space', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  signal({ val: 'hello world ', len: 12 }, { tag: 'TEXTAREA', name: 'user_message' }, 'ta');
  assert.deepEqual(rfb.tapped(), []);
});

test('bounded: a page that keeps re-adding the space stops being backspaced', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  for (let i = 0; i < 6; i++) {
    advanceClock(500);
    signal({ val: 'a@b.co ', len: 7 });
  }
  assert.deepEqual(rfb.tapped(), [BS, BS, BS], 'SPACE_REPAIR_MAX attempts, then it gives up');
});

test('the attempt budget resets for a different field', async () => {
  const { rfb } = await raised();
  rfb.clearKeys();
  for (let i = 0; i < 5; i++) { advanceClock(500); signal({ val: 'a@b.co ', len: 7 }); }
  advanceClock(500);
  signal({ val: 'c@d.co ', len: 7 }, EMAIL_HINTS, 'f2'); // user tabs to a second address field
  assert.deepEqual(rfb.tapped(), [BS, BS, BS, BS], 'three for f1, a fresh one for f2');
});
