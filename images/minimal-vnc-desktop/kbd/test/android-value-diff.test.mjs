// android-value-diff.test.mjs — characterization: Android hidden-<input> path
// (no EditContext; Samsung/older browsers). The proxy VALUE is the source of
// truth; onProxyInput diffs it against lastSentValue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fire, pushSignal, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS, ENTER, TAB } from './mock-rfb.mjs';

installGlobals('android-input');

// Type into the proxy the way the browser does: mutate value, then fire input.
function type(proxy, newValue, inputType) {
  proxy.value = newValue;
  return fire(proxy, 'input', { inputType: inputType || 'insertText' });
}

test('append-only edits send just the new tail', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  type(proxy, 'h');
  type(proxy, 'he');
  type(proxy, 'hello');
  assert.deepEqual(rfb.tapped(), keysymsFor('hello'));
});

test('value shrink sends grapheme-aware backspaces', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  type(proxy, 'hey');
  rfb.clearKeys();
  type(proxy, 'h', 'deleteContentBackward'); // clean-suffix shrink by 2… but
  // NOTE: explicit deleteContentBackward inputType short-circuits to ONE Backspace
  // (the per-keystroke delete path), matching the real event stream where each
  // press fires its own input event.
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('shrink WITHOUT delete inputType backspaces the whole removed tail', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  type(proxy, 'hey there');
  rfb.clearKeys();
  type(proxy, 'hey', 'insertText'); // e.g. selection replace / autocorrect collapse
  assert.deepEqual(rfb.tapped(), [BS, BS, BS, BS, BS, BS]); // ' there' = 6 units
});

test('non-suffix shrink (mid-word delete) deletes the whole old value then retypes — no duplication', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  // Send 'helllo' first so lastSentValue is populated.
  type(proxy, 'helllo');
  rfb.clearKeys();
  // Autocorrect fixes the doubled 'l': shorter AND diverges (not a clean suffix
  // removal, since 'helllo'.startsWith('hello') is false).
  type(proxy, 'hello');
  // Must clear all 6 chars then retype 'hello' — NOT backspace-1 + retype
  // (which would leave 'helll' + 'hello' = 'helllhello' on the remote).
  assert.deepEqual(rfb.tapped(), [BS, BS, BS, BS, BS, BS, ...keysymsFor('hello')]);
});

test('same-length autocorrect deletes the old word and retypes the new', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  type(proxy, 'teh');
  rfb.clearKeys();
  type(proxy, 'the'); // same length, different content
  assert.deepEqual(rfb.tapped(), [BS, BS, BS, ...keysymsFor('the')]);
});

test('SwiftKey auto-space after punctuation is stripped (non-sensitive field)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  type(proxy, 'hi!');
  rfb.clearKeys();
  type(proxy, 'hi! x'); // SwiftKey injects the space after '!'
  assert.deepEqual(rfb.tapped(), keysymsFor('x')); // space stripped
});

test('multi-word batch keeps its internal space after punctuation (glide/voice/paste)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  // A whole phrase delivered in ONE insertText (glide of multiple words, voice
  // dictation, or a paste routed through the value-diff). The space after '.' is
  // legitimate user content and must survive.
  type(proxy, 'Hello. World');
  assert.deepEqual(rfb.tapped(), keysymsFor('Hello. World'));
});

test('bundled punctuation+space pair is still stripped (SwiftKey auto-space)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  type(proxy, 'hi');
  rfb.clearKeys();
  // SwiftKey commits the period and its auto-space together as one 2-char step.
  type(proxy, 'hi. ');
  assert.deepEqual(rfb.tapped(), keysymsFor('.')); // the injected space is dropped
});

test('sensitive field: auto-space is NOT stripped', async () => {
  const { rfb, proxy, kbdSock } = await freshViewer(createMockRfb);
  assert.ok(kbdSock);
  pushSignal({ editable: true, focusKey: 'pw1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { type: 'password' }, sync: { sensitive: true, len: 0 } });
  type(proxy, 'hi!');
  rfb.clearKeys();
  type(proxy, 'hi! x');
  assert.deepEqual(rfb.tapped(), keysymsFor(' x')); // space passes through untouched
});

test('empty-field Backspace via beforeinput goes straight to the remote', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'beforeinput', { inputType: 'deleteContentBackward' });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('keydown Enter sends action key and clears the proxy', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  type(proxy, 'go');
  rfb.clearKeys();
  proxy.value = 'go';
  const e = fire(proxy, 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), [ENTER]);
  assert.equal(proxy.value, '');
});

test('keydown Tab forwards Tab and clears', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'keydown', { key: 'Tab', keyCode: 9 });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), [TAB]);
});

test('Unidentified keydown fires a deferred remote Backspace (Indic/glide delete)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  assert.deepEqual(rfb.tapped(), []); // not yet — deferred 90ms
  await sleep(150);
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('a real character cancels the deferred Unidentified backspace', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'a' }); // cancels timer
  type(proxy, 'a');
  await sleep(150);
  assert.deepEqual(rfb.tapped(), keysymsFor('a')); // no spurious Backspace
});

test('sensitive field: Unidentified deletes too — a secret must be correctable', async () => {
  // This used to assert the opposite ("never guess on a secret"), trading a rare
  // wrong guess for a constant silent one: Gboard glide, Indic, SwiftKey and
  // Samsung all report delete as 'Unidentified', so on a password it did NOTHING
  // and the login failed on a correct secret. A real character still cancels the
  // deferral (test above), which is what makes it safe.
  const { rfb, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'pw2', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { type: 'password' }, sync: { sensitive: true, len: 0 } });
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  await sleep(150);
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('sensitive field: a real character still cancels the deferred backspace', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'pw3', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { type: 'password' }, sync: { sensitive: true, len: 0 } });
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'a' });
  type(proxy, 'a');
  await sleep(150);
  assert.deepEqual(rfb.tapped(), keysymsFor('a'));
});

test('remote-driven field switch clears the stale proxy buffer (no cross-field corruption)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const RECT = { x: 100, y: 200, w: 200, h: 40 };
  const canvas = makeScreen().querySelector('canvas');
  // Raise the keyboard on field A with a tap, then confirm A focused.
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [RECT] });
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  pushSignal({ editable: true, focusKey: 'A', rect: RECT, hints: { tag: 'INPUT' }, sync: { len: 0 }, vw: 390, vh: 844, rects: [RECT] });
  assert.equal(globalThis.document.activeElement, proxy, 'keyboard up on field A');
  // Type into A, so the proxy holds 'hello' and lastSentValue='hello'.
  type(proxy, 'hello');
  assert.equal(proxy.value, 'hello');
  rfb.clearKeys();
  // The page auto-advances focus to a DIFFERENT field B while the keyboard stays
  // up (OTP/checkout). The stale 'hello' buffer must be wiped so B starts clean.
  pushSignal({ editable: true, focusKey: 'B', rect: RECT, hints: { tag: 'INPUT' }, sync: { len: 0 }, vw: 390, vh: 844, rects: [RECT] });
  assert.equal(proxy.value, '', 'proxy buffer reset on remote-driven field switch');
  // B's first edit is a plain insert — NOT BS×5 clearing A's 'hello' + retype
  // (which on a prefilled B would delete B's real content).
  type(proxy, 'x');
  assert.deepEqual(rfb.tapped(), keysymsFor('x'));
});

test('composing input is mirrored per step via minimal diff (Android composes every word)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'compositionstart', {});
  proxy.value = '가';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  proxy.value = '갃';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  // step 1 sends 가; step 2 is a same-position morph: BS + 갃 (minimal diff)
  assert.deepEqual(rfb.tapped(), [keysymsFor('가')[0], BS, keysymsFor('갃')[0]]);
});
