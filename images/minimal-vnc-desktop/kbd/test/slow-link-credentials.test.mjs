// slow-link-credentials.test.mjs — what a SLOW link does to credential entry.
//
// This is the path E2E encryption reaches indirectly: Noise wraps the /kbd
// signal socket, the /input socket and RFB, so the tunnel RTT probe measures the
// encrypted round trip and linkLatency() rises. Nothing about the keysym stream
// changes — but several IME behaviours branch on that number, and commit-only
// composition is the one that changes what gets sent and when.
//
// Separate file because seeding the shared latency EMA flips commitOnly() for
// every other test in the process (same reason as slow-link-ec.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, findSecureProxy, fire, fireEC, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-ec');

const { noteRtt, linkLatency } = await import('../latency.js');
noteRtt(2000);
assert.ok(linkLatency() > 700, 'latency seed failed');

const RECT = { x: 0, y: 0, w: 10, h: 10 };
const focusField = (hints, sensitive) => pushSignal({
  editable: true, focusKey: 'f1', rect: RECT, hints,
  sync: { sensitive: !!sensitive, len: sensitive ? undefined : 0 },
});

test('slow link + OTP: composing digits are withheld, then flushed intact', async () => {
  // An OTP field is sensitive but deliberately KEEPS the EditContext surface
  // (password mode would cost it the numeric pad and the SMS chip), so it is the
  // one credential-bearing field that commit-only actually reaches. A code that
  // arrives short or reordered here is a failed login with no feedback.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'text', autoComplete: 'one-time-code', inputMode: 'numeric' }, true);
  const ec = proxy.editContext;
  fireEC(ec, 'compositionstart', {});
  ec.text = '12';
  fireEC(ec, 'textupdate', { text: '12', updateRangeStart: 0, updateRangeEnd: 0 });
  ec.text = '1234';
  fireEC(ec, 'textupdate', { text: '34', updateRangeStart: 2, updateRangeEnd: 2 });
  assert.deepEqual(rfb.tapped(), [], 'nothing leaks mid-composition on a slow link');
  fireEC(ec, 'compositionend', {});
  assert.deepEqual(rfb.tapped(), keysymsFor('1234'), 'the whole code arrives exactly once');
});

test('slow link does NOT suppress on the secure password surface', async () => {
  // commitOnly() is consulted in exactly one place — onECTextUpdate. A password
  // swaps the IME onto an <input type=password>, which runs the value-diff path,
  // so latency cannot change how a password is sent. That is what makes E2E safe
  // for credentials: the encrypted tunnel raises linkLatency(), but the branch it
  // gates is not on the password path at all.
  const { rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'password', autoComplete: 'current-password' }, true);
  const secure = findSecureProxy();
  assert.ok(secure, 'expected the secure surface');
  rfb.clearKeys();
  secure.value = 'a'; fire(secure, 'input', { inputType: 'insertText' });
  assert.deepEqual(rfb.tapped(), keysymsFor('a'), 'sent immediately, not withheld');
  secure.value = 'a b'; fire(secure, 'input', { inputType: 'insertText' });
  assert.deepEqual(rfb.tapped(), keysymsFor('a b'), 'passphrase space still passes on a slow link');
});
