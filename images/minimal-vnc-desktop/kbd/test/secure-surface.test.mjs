// secure-surface.test.mjs — Android credential fields must compose into an
// <input type=password>, not the EditContext div.
//
// EditContext derives its text-input type from `inputmode`, which has no
// password value, so a credential field on the EC surface looks like prose to
// the IME: it offers the suggestion strip, commits word+SPACE when one is
// tapped, and turns a double space into ". ". Measured on Android 14 / Gboard
// through LiveView: tapping the `hello` suggestion put "hello " (U+0020) into a
// password, and two space taps put "ab. " (U+002E U+0020). Both are characters
// the user never typed, and nothing downstream may strip them — the send-side
// filters skip sensitive fields on purpose, because deleting whitespace from an
// invisible secret is the worse failure (autospace.js, transport.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, findSecureProxy, fire, fireEC, fireDoc, makeScreen, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-ec');

const RECT = { x: 0, y: 0, w: 10, h: 10 };
const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

function focusField({ sensitive, key, type }) {
  pushSignal({
    editable: true, focusKey: key, rect: RECT,
    hints: { type: type || (sensitive ? 'password' : 'text') },
    sync: sensitive ? { sensitive: true, len: 0 } : { sensitive: false, len: 0 },
  });
}

// Type into the value-diff proxy the way the browser does.
function type(proxy, newValue, inputType) {
  proxy.value = newValue;
  return fire(proxy, 'input', { inputType: inputType || 'insertText' });
}

// A soft-keyboard text event is what latches keyboardActive, and the surface
// swap only moves DOM focus when the keyboard is actually up (otherwise it would
// focus a proxy while nothing is being typed into). Put the core in that state.
function keyboardUp(proxy) {
  fireEC(proxy.editContext, 'textupdate', { text: '', updateRangeStart: 0, updateRangeEnd: 0 });
}

test('the Android secure surface exists and is a password input', async () => {
  await freshViewer(createMockRfb);
  const secure = findSecureProxy();
  assert.ok(secure, 'no secure proxy was built on the EditContext path');
  assert.equal(secure.tagName, 'INPUT');
  assert.equal(secure.type, 'password');
  // A password input is what makes the IME drop suggestions and auto-space; if
  // this ever reverts to text the whole guarantee is gone silently.
  assert.ok(!secure.editContext, 'the secure surface must not carry an EditContext');
});

test('a sensitive field moves the IME onto the password surface', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  assert.ok(proxy.editContext, 'expected the EditContext surface by default');
  keyboardUp(proxy);
  focusField({ sensitive: true, key: 'pw1' });
  assert.equal(globalThis.document.activeElement, findSecureProxy());
});

test('text typed on the secure surface still reaches the remote', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  rfb.clearKeys();
  type(secure, 'a');
  type(secure, 'ab');
  assert.deepEqual(rfb.tapped(), keysymsFor('ab'));
});

test('a space typed into a password is still forwarded verbatim', async () => {
  // The fix removes the IME's REASON to invent whitespace; it must not start
  // filtering whitespace the user actually typed. A passphrase space is legal.
  const { rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  type(secure, 'ab');
  rfb.clearKeys();
  type(secure, 'ab c');
  assert.deepEqual(rfb.tapped(), keysymsFor(' c'));
});

test('leaving the credential field returns the IME to EditContext', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  keyboardUp(proxy);
  focusField({ sensitive: true, key: 'pw1' });
  assert.equal(globalThis.document.activeElement, findSecureProxy());
  focusField({ sensitive: false, key: 'text1' });
  // Glide typing and the prediction bar ride the EC surface — a stale secure
  // proxy would cost every later prose field both.
  assert.equal(globalThis.document.activeElement, proxy);
});

test('the buffer does not travel between surfaces', async () => {
  // Each surface keeps its own text. Carrying the username across would diff the
  // password against it and send backspaces over someone's secret.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: false, key: 'user1' });
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  assert.equal(secure.value, '');
  rfb.clearKeys();
  type(secure, 'x');
  assert.deepEqual(rfb.tapped(), keysymsFor('x'));
  focusField({ sensitive: false, key: 'user1' });
  assert.equal(proxy.value === '' || proxy.value === undefined, true);
});

test('re-signalling the same sensitivity does not re-swap', async () => {
  // applySignal runs on every heartbeat; a swap per frame would blur and refocus
  // the proxy continuously and fight the keyboard.
  const { proxy } = await freshViewer(createMockRfb);
  keyboardUp(proxy);
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  const before = globalThis.document.activeElement;
  focusField({ sensitive: true, key: 'pw1' });
  focusField({ sensitive: true, key: 'pw1' });
  assert.equal(globalThis.document.activeElement, before);
  assert.equal(before, secure);
});

// ---- the two holes a single trigger would leave --------------------------
// Secrecy and field identity change independently, so keying the surface off
// either one alone leaves a credential field wearing the prose keyboard.

test('secrecy flipping on the SAME focusKey still moves the surface', async () => {
  // A "show password" toggle rewrites type=password <-> text on one element, and
  // pages that reuse a focusKey across fields change field without looking new —
  // the carry-over hunt logged one constant focusKey for a whole session.
  const { proxy } = await freshViewer(createMockRfb);
  keyboardUp(proxy);
  focusField({ sensitive: false, key: 'same' });
  // Nothing has moved focus yet — a prose field just stays on the default
  // surface, which is why this half of the check is "not the secure one".
  assert.notEqual(globalThis.document.activeElement, findSecureProxy());
  focusField({ sensitive: true, key: 'same' }); // same key, now a secret
  assert.equal(globalThis.document.activeElement, findSecureProxy());
  focusField({ sensitive: false, key: 'same' }); // revealed again
  assert.equal(globalThis.document.activeElement, proxy);
});

test('the swap does not read as a system dismiss', async () => {
  // Swapping moves DOM focus, so the outgoing proxy blurs. Untreated, that is
  // indistinguishable from a back-button/swipe-down dismiss and would tear the
  // keyboard down mid-login — and the 100ms post-dismiss grace would then swallow
  // the user's next tap. Observable exactly as the lifecycle tests observe a
  // dismiss: whether a tap right afterwards can still focus the proxy.
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: screen.querySelector('canvas') });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: screen.querySelector('canvas') });
  pushSignal({ editable: true, focusKey: 'pw1', rect: FIELD_RECT, hints: { tag: 'INPUT', type: 'password' },
    sync: { sensitive: true, len: 0 }, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const secure = findSecureProxy();
  assert.equal(globalThis.document.activeElement, secure, 'swapped to the secure surface');
  fire(proxy, 'blur'); // the browser's blur from the focus move
  await sleep(120);    // past the 100ms grace a real dismiss would have armed
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: screen.querySelector('canvas') });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: screen.querySelector('canvas') });
  assert.equal(globalThis.document.activeElement, secure, 'keyboard survived the swap');
});

test('a secret does not survive on the surface for the next visit', async () => {
  // clearProxy() acts on the LIVE surface, so clearing on the way out never
  // touches the one being swapped in. Re-entering a credential field would then
  // find the previous secret still sitting in the password <input> while the
  // diff baseline reads empty — and resend the whole thing.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  keyboardUp(proxy);
  focusField({ sensitive: true, key: 'pw1' });
  const secure = findSecureProxy();
  type(secure, 'hunter2');
  focusField({ sensitive: false, key: 'user1' }); // leave the credential field
  focusField({ sensitive: true, key: 'pw2' });    // and come back to another one
  assert.equal(secure.value, '', 'no secret left on the surface');
  rfb.clearKeys();
  type(secure, 'x');
  assert.deepEqual(rfb.tapped(), keysymsFor('x'), 'nothing replayed from last time');
});
