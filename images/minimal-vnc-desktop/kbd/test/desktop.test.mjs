// desktop.test.mjs — characterization: desktop keyboard bridge + clipboard paste
// (the explicit clipboard handlers are desktop-only; mobile pastes ride the
// normal input path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS } from './mock-rfb.mjs';

installGlobals('desktop');

test('non-printable keys forward as keysym press/release chords', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'keydown', { key: 'ArrowLeft', keyCode: 37, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.chords(), [[0xff51, true], [0xff51, false]]);
});

test('Ctrl+A sends a Control chord around the letter; ⌘ maps to Control', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'keydown', { key: 'a', keyCode: 65, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x61, true], [0x61, false], [0xffe3, false]]);
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'c', keyCode: 67, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x63, true], [0x63, false], [0xffe3, false]]);
});

test('unmodified printable keydown is ignored (input/composition owns it)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'keydown', { key: 'a', keyCode: 65, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(rfb.keys, []);
});

test('committed input value is sent and the proxy cleared', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  proxy.value = 'hey';
  fire(proxy, 'input', {});
  assert.deepEqual(rfb.tapped(), keysymsFor('hey'));
  assert.equal(proxy.value, '');
});

test('plain Backspace routes through sendSpecialKey (echo stays in sync)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'keydown', { key: 'Backspace', keyCode: 8, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('Ctrl/⌘+V is NOT forwarded — the paste event owns it', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(rfb.keys, []);
});

test('short paste sends per-char keysyms', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'paste', { clipboardData: { getData: () => 'hi there' } });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), keysymsFor('hi there'));
  assert.deepEqual(rfb.clipboard, []);
});

test('long Latin-1 paste stages on the remote clipboard + Ctrl+V (one round-trip)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const text = 'a'.repeat(40);
  fire(proxy, 'paste', { clipboardData: { getData: () => text } });
  assert.deepEqual(rfb.clipboard, [text]);
  // Ctrl+V chord: Control down, v down, v up, Control up
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x76, true], [0x76, false], [0xffe3, false]]);
  assert.deepEqual(rfb.tapped(), []); // no per-char fallback
});

test('long CJK paste WITHOUT Extended Clipboard falls back to per-char keysyms', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const text = '水'.repeat(40); // >32 chars, not Latin-1; mock negotiates no ext-clipboard
  fire(proxy, 'paste', { clipboardData: { getData: () => text } });
  assert.deepEqual(rfb.clipboard, []); // would corrupt to '?' via ISO-8859-1 — must not stage
  assert.equal(rfb.tapped().length, 40);
});

test('newlines are stripped when pasting into a single-line INPUT', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'f1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { tag: 'INPUT' }, sync: {} });
  rfb.clearKeys();
  fire(proxy, 'paste', { clipboardData: { getData: () => 'user\n' } });
  assert.deepEqual(rfb.tapped(), keysymsFor('user')); // no Enter fired at the form
});

test('remote focus signal moves key focus to the proxy; blur hands it back', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'f2', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: {}, sync: {} });
  assert.equal(globalThis.document.activeElement, proxy);
  pushSignal({ editable: false });
  assert.notEqual(globalThis.document.activeElement, proxy);
});
