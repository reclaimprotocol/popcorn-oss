// ios-input.test.mjs — characterization: iOS <input> path (beforeinput is the
// source of truth). Profile pinned per process: see stub-dom.mjs header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS, ENTER, TAB } from './mock-rfb.mjs';

installGlobals('ios');

test('insertText sends one keysym per codepoint and preventDefaults', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'hi' });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), keysymsFor('hi'));
});

test('surrogate pair / emoji sends ONE keysym', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: '😀' });
  assert.deepEqual(rfb.tapped(), [0x01000000 | 0x1f600]);
});

test('newline and tab inside text route to Enter/Tab special keysyms; other control chars skipped', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'a\nb\tc\x07d' });
  assert.deepEqual(rfb.tapped(), [0x61, ENTER, 0x62, TAB, 0x63, 0x64]);
});

test('insertReplacementText backspaces the tracked word then types the pick', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'Tes' });
  rfb.clearKeys();
  fire(proxy, 'beforeinput', { inputType: 'insertReplacementText', data: 'Testing' });
  assert.deepEqual(rfb.tapped(), [BS, BS, BS, ...keysymsFor('Testing')]);
});

test('word tracking resets at spaces: replacement only eats the current word', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'hello wor' });
  rfb.clearKeys();
  fire(proxy, 'beforeinput', { inputType: 'insertReplacementText', data: 'world' });
  assert.deepEqual(rfb.tapped(), [BS, BS, BS, ...keysymsFor('world')]);
});

test('backspace on empty field sends remote Backspace and seeds the chew buffer', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'beforeinput', { inputType: 'deleteContentBackward' });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), [BS]);
  // chew buffer seeded: 120 word-joiners so a HELD backspace keeps repeating
  assert.equal(proxy.value.length, 120);
  assert.equal(proxy.value[0], '⁠');
});

test('held backspace: buffer shrink converts to N remote Backspaces and refills', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'deleteContentBackward' }); // seed
  rfb.clearKeys();
  // iOS repeat tick: not prevented, the field actually shrinks by 1, then input fires
  proxy.value = '⁠'.repeat(119);
  fire(proxy, 'input', { inputType: 'deleteContentBackward' });
  assert.deepEqual(rfb.tapped(), [BS]);
  assert.equal(proxy.value.length, 120); // refilled to keep the hold alive
});

test('typing after a delete streak tears the chew buffer down (clean empty field)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'deleteContentBackward' });
  assert.equal(proxy.value.length, 120);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'x' });
  assert.equal(proxy.value, '');
});

test('insertLineBreak sends Enter (default action key)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'insertLineBreak' });
  assert.deepEqual(rfb.tapped(), [ENTER]);
});

test('enterKeyHint=next turns the action key into Tab; previous into Shift+Tab chord', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'f1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { enterKeyHint: 'next' }, sync: {} });
  fire(proxy, 'beforeinput', { inputType: 'insertLineBreak' });
  assert.deepEqual(rfb.tapped(), [TAB]);
  rfb.clearKeys();
  pushSignal({ editable: true, focusKey: 'f2', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { enterKeyHint: 'previous' }, sync: {} });
  fire(proxy, 'beforeinput', { inputType: 'insertLineBreak' });
  // Shift down, Tab down, Tab up, Shift up
  assert.deepEqual(rfb.chords(), [[0xffe1, true], [0xff09, true], [0xff09, false], [0xffe1, false]]);
});

test('remote field hints shape the proxy IME attributes (email field)', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'em1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { type: 'email', tag: 'INPUT' }, sync: {} });
  assert.equal(proxy.getAttribute('inputmode'), 'email');     // derived from type
  assert.equal(proxy.getAttribute('enterkeyhint'), 'go');     // email → Go glyph
  assert.equal(proxy.getAttribute('autocapitalize'), 'none'); // literal field
  assert.equal(proxy.getAttribute('autocorrect'), 'off');     // non-mirror: always off
  assert.equal(proxy.getAttribute('autocomplete'), 'off');    // no AutoFill bar
});

test('number field derives the decimal keypad (not digits-only numeric)', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'n1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { type: 'number', tag: 'INPUT' }, sync: {} });
  assert.equal(proxy.getAttribute('inputmode'), 'decimal'); // "1.50" must be typeable
  assert.equal(proxy.type, 'text'); // never mirror the remote type onto the proxy
});

test('one-time-code autocomplete is the only value allowed through (SMS autofill)', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'otp1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { autoComplete: 'one-time-code' }, sync: {} });
  assert.equal(proxy.getAttribute('autocomplete'), 'one-time-code');
});

test('keydown Backspace with empty value deletes on the remote even mid-composition flags', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'keydown', { key: 'Backspace', keyCode: 8, isComposing: true });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), [BS]);
});
