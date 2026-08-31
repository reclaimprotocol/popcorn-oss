// secure-delete.test.mjs — the delete key must work on a SECRET, whichever
// Android keyboard is installed.
//
// Android never names the running IME, and they disagree on how a delete arrives:
// Gboard leaves a glided word composing and fires 'Unidentified' with a non-empty
// buffer; Indic and most third-party keyboards report 'Unidentified' generally;
// SwiftKey holds the corrected word in ITS buffer, so its backspaces come as
// 'Unidentified' plus an EMPTY textupdate carrying no deletion. Only an identified
// 'Backspace' on an empty buffer is unambiguous, and nothing must send that.
//
// So the viewer defers a backspace and lets a real character cancel it. Skipping
// that on secrets left the delete key doing NOTHING on a password or OTP — the
// typo was uncorrectable and the login failed with no signal anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, findSecureProxy, fire, fireEC, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-ec');

const RECT = { x: 0, y: 0, w: 10, h: 10 };
const BACKSPACE = 0xff08;
const DEFER_MS = 200; // the deferral is 90ms; leave room for it to fire

function focusField({ sensitive, key, hints }) {
  pushSignal({
    editable: true, focusKey: key, rect: RECT,
    hints: hints || { tag: 'INPUT', type: sensitive ? 'password' : 'text' },
    sync: { sensitive, len: sensitive ? undefined : 0 },
  });
}

test('Gboard/Indic: an Unidentified delete on a password reaches the remote', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  rfb.clearKeys();
  fire(secure, 'keydown', { key: 'Unidentified', keyCode: 229 });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), [BACKSPACE]);
});

test('SwiftKey: a phantom delete on a password reaches the remote', async () => {
  // The corrected word lives in SwiftKey's buffer, not ours, so its backspaces
  // produce an EMPTY non-composing textupdate. That shape must NOT cancel the
  // deferred backspace, or the first few presses vanish into the phantom word.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  rfb.clearKeys();
  fire(secure, 'keydown', { key: 'Unidentified', keyCode: 229 });
  fireEC(proxy.editContext, 'textupdate', { text: '', updateRangeStart: 0, updateRangeEnd: 0 });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), [BACKSPACE]);
});

test('an OTP field, which keeps the text surface, can still be corrected', async () => {
  // A one-time-code box stays on the EditContext surface on purpose (password mode
  // would cost it the numeric pad and the SMS chip), so it keeps every IME shape
  // above — including glide deletes — while still counting as sensitive.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'otp1',
    hints: { tag: 'INPUT', type: 'text', autoComplete: 'one-time-code', inputMode: 'numeric' } });
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), [BACKSPACE]);
});

test('a real character still cancels the deferred backspace on a secret', async () => {
  // The reason the deferral is safe: any textupdate carrying text proves the
  // ambiguous keydown was a character, not a delete. A secret must not start
  // collecting spurious backspaces in exchange for the fix above.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  rfb.clearKeys();
  fire(secure, 'keydown', { key: 'Unidentified', keyCode: 229 });
  proxy.editContext.text = 'a';
  fireEC(proxy.editContext, 'textupdate', { text: 'a', updateRangeStart: 0, updateRangeEnd: 0 });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), keysymsFor('a'), 'no stray backspace before the character');
});
