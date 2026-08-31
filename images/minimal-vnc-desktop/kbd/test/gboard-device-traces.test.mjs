// gboard-device-traces.test.mjs — replays event shapes CAPTURED FROM A REAL
// DEVICE, not shapes we believed Gboard produces.
//
// Recorded on an Android 14 emulator (API 34, Google Play image, arm64) running
// Gboard 12.4.05 in Chrome 113 — so EditContext is absent and this is the
// hidden-<input> value-diff path, the same one Samsung and Android WebView take.
// Captured with mobile-harness/ime-trace, which serves a page instrumented like
// the viewer's proxy and posts every DOM event back.
//
// These traces are the ground truth the hand-authored tests were missing: the
// suite asserted what we assumed a keyboard does, which is how the delete and
// whitespace defects shipped. Re-record with ime-trace/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS } from './mock-rfb.mjs';

installGlobals('android-input');

const RECT = { x: 0, y: 0, w: 10, h: 10 };

function focusField(hints, sensitive) {
  pushSignal({ editable: true, focusKey: 'f1', rect: RECT, hints,
    sync: { sensitive: !!sensitive, len: sensitive ? undefined : 0 } });
}
function ev(proxy, value, inputType, isComposing) {
  proxy.value = value;
  fire(proxy, 'input', { inputType, isComposing: !!isComposing });
}

test('Gboard word-delete: one deleteContentBackward empties the whole field', async () => {
  // CAPTURED: swipe-left on the backspace key fires ONE
  // beforeinput/input deleteContentBackward that takes the value 11 -> 0.
  // keydown arrives as 'Unidentified'. The old code sent a single Backspace and
  // left ten characters on the remote while lastSentValue said the field was
  // empty — every later edit then built on a wrong baseline.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'text' });
  ev(proxy, 'hello world', 'insertCompositionText', true);
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  ev(proxy, '', 'deleteContentBackward');
  assert.deepEqual(rfb.tapped(), Array(11).fill(BS));
});

test('Gboard on type=password: plain insertText, never composing', async () => {
  // CAPTURED: the SAME keystrokes that compose on a prose field arrive on a
  // password as insertText with isComposing false and no compositionstart at
  // all. This is what the secure surface buys — no composition means no
  // suggestion strip, so no word+SPACE can ever be committed into a secret.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'password', name: 'user[password]' }, true);
  rfb.clearKeys();
  ev(proxy, 'a', 'insertText');
  ev(proxy, 'ab', 'insertText');
  ev(proxy, 'abc', 'insertText');
  assert.deepEqual(rfb.tapped(), keysymsFor('abc'));
});

test('Gboard backspace on an empty field still deletes remotely', async () => {
  // CAPTURED: key='Backspace' plus deleteContentBackward, with the value staying
  // empty — nothing shrinks locally, so only the inputType reports the delete.
  // Note the shape: keydown, then beforeinput, and NO input event — nothing in
  // the field changed, so the browser never fires one. The keydown handler is the
  // only thing that can carry this delete to the remote.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'password' }, true);
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Backspace', keyCode: 8 });
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('Gboard suggestion tap commits word+SPACE — dropped on a username field', async () => {
  // CAPTURED: tapping the bold "The" suggestion for "Teh" committed
  // insertCompositionText with data "The " — the word plus a trailing space
  // nobody typed. On an address-like field that space is what makes a site
  // reject a correct login, so the send path drops it.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'text', name: 'user[login]', autoComplete: 'username' });
  fire(proxy, 'compositionstart', {});   // Gboard opens a composition per word
  ev(proxy, 'teh', 'insertCompositionText', true);
  rfb.clearKeys();
  ev(proxy, 'the ', 'insertCompositionText', true);
  // Minimal composing edit: keep the shared 't', replace the rest. The space in
  // the committed "the " is dropped because the field is address-like.
  assert.deepEqual(rfb.tapped(), [BS, BS, ...keysymsFor('he')], 'the invented space never goes out');
});

test('the same suggestion space is NOT stripped from a password', async () => {
  // Same shape, sensitive field: a passphrase space is legal and the send path
  // must leave it alone. The secure surface is what stops the IME inventing one.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'password', name: 'user[password]' }, true);
  ev(proxy, 'teh', 'insertText');
  rfb.clearKeys();
  ev(proxy, 'teh ', 'insertText');
  assert.deepEqual(rfb.tapped(), keysymsFor(' '));
});

test('Gboard double-space becomes ". " via a delete plus an insert', async () => {
  // CAPTURED on a prose field: "ab " -> deleteContentBackward -> "ab" ->
  // insertText ". " -> "ab. ". Two separate events, and the second is
  // a punctuation+space pair, which is exactly the SwiftKey auto-space shape
  // autospace.js strips on Android.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ tag: 'INPUT', type: 'text' });
  ev(proxy, 'ab ', 'insertCompositionText', true);
  rfb.clearKeys();
  ev(proxy, 'ab', 'deleteContentBackward');
  ev(proxy, 'ab. ', 'insertText');
  assert.deepEqual(rfb.tapped(), [BS, ...keysymsFor('.')], 'the auto-space is stripped, the period is not');
});
