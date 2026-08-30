// secure-input-path.test.mjs — the Android hidden-<input> path (Samsung, older
// Chromium, and Android WebView, which does not expose EditContext) must put the
// proxy into password mode for a credential field.
//
// This is the path the Android WebView actually takes, so it is where the
// reported bug lands: on a type=text proxy the IME offers suggestions on a
// password and commits word+SPACE / double-space-to-period into it. Unlike the
// EditContext path there is no second element to swap to — the one proxy just
// has to change type, which is enough to make the IME drop the prose pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-input');

const RECT = { x: 0, y: 0, w: 10, h: 10 };

function focusField({ sensitive, key, type }) {
  pushSignal({
    editable: true, focusKey: key, rect: RECT,
    hints: { tag: 'INPUT', type: type || (sensitive ? 'password' : 'text') },
    sync: sensitive ? { sensitive: true, len: 0 } : { sensitive: false, len: 0 },
  });
}

function type(proxy, newValue, inputType) {
  proxy.value = newValue;
  return fire(proxy, 'input', { inputType: inputType || 'insertText' });
}

test('focusing a credential field puts the proxy in password mode', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  assert.equal(proxy.type, 'text');
  focusField({ sensitive: true, key: 'pw1' });
  assert.equal(proxy.type, 'password');
});

test('moving to a non-credential field restores text mode', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  assert.equal(proxy.type, 'password');
  focusField({ sensitive: false, key: 'user1' });
  assert.equal(proxy.type, 'text');
});

test('typing into the password-mode proxy still reaches the remote', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  rfb.clearKeys();
  type(proxy, 'a');
  type(proxy, 'ab');
  assert.deepEqual(rfb.tapped(), keysymsFor('ab'));
});

test('a space the user actually types into a password still goes through', async () => {
  // The fix removes the IME's reason to invent whitespace. It must not start
  // deleting whitespace: a passphrase space is legal, and silently dropping one
  // is the failure mode autospace.js refuses to create.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  type(proxy, 'ab');
  rfb.clearKeys();
  type(proxy, 'ab c');
  assert.deepEqual(rfb.tapped(), keysymsFor(' c'));
});

test('secrecy flipping on the SAME focusKey still changes the mode', async () => {
  // The hole a new-field-only trigger leaves. Two real shapes hit it: a "show
  // password" toggle rewrites type on ONE element, and pages that reuse a single
  // focusKey change field without ever looking new (the carry-over hunt logged a
  // constant focusKey for a whole session). Either way the password would keep
  // the previous field's prose keyboard — the exact reported bug.
  const { proxy } = await freshViewer(createMockRfb);
  focusField({ sensitive: false, key: 'same' });
  assert.equal(proxy.type, 'text');
  focusField({ sensitive: true, key: 'same' });
  assert.equal(proxy.type, 'password');
  focusField({ sensitive: false, key: 'same' });
  assert.equal(proxy.type, 'text');
});

test('the previous field text cannot leak into the credential', async () => {
  // Retyping an <input> PRESERVES its value, so without an explicit clear the
  // proxy carries the username into the password session. The diff would then
  // either backspace over the secret or prepend the username to it.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: false, key: 'user1' });
  type(proxy, 'alice');
  focusField({ sensitive: true, key: 'pw1' });
  assert.equal(proxy.value, '', 'buffer cleared on the way into the secret');
  rfb.clearKeys();
  type(proxy, 'p');
  assert.deepEqual(rfb.tapped(), keysymsFor('p'), 'no backspaces, no leftover tail');
});

test('an OTP field keeps its numeric pad and its SMS chip', async () => {
  // isSensitiveField() calls a short numeric box a secret (OTP/PIN/CVV), which is
  // right for echo and drift but wrong for the surface: type=password would hand
  // Chrome the TEXT keyboard and drop the one-time-code chip, breaking SMS
  // autofill on a field that has no prose pipeline to protect it from.
  const { proxy } = await freshViewer(createMockRfb);
  pushSignal({
    editable: true, focusKey: 'otp1', rect: RECT,
    hints: { tag: 'INPUT', type: 'text', autoComplete: 'one-time-code', inputMode: 'numeric' },
    sync: { sensitive: true, len: 0 },
  });
  assert.equal(proxy.type, 'text');
  assert.equal(proxy.getAttribute('inputmode'), 'numeric');
  assert.equal(proxy.getAttribute('autocomplete'), 'one-time-code');
});

test('a card-number field keeps its numeric pad', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  pushSignal({
    editable: true, focusKey: 'cc1', rect: RECT,
    hints: { tag: 'INPUT', type: 'text', pattern: '[0-9]*' },
    sync: { sensitive: true, len: 0 },
  });
  assert.equal(proxy.type, 'text');
  assert.equal(proxy.getAttribute('inputmode'), 'numeric');
});
