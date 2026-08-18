// desktop.test.mjs — characterization: desktop keyboard bridge + clipboard paste
// (the explicit clipboard handlers are desktop-only; mobile pastes ride the
// normal input path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, fireWindow, pushSignal } from './stub-dom.mjs';
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

test('short paste into a KNOWN focused field sends per-char keysyms', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: {}, sync: {} });
  rfb.clearKeys();
  const e = fire(proxy, 'paste', { clipboardData: { getData: () => 'hi there' } });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), keysymsFor('hi there'));
  assert.deepEqual(rfb.clipboard, []);
});

// With no field known-focused, per-char keysyms would land as single-key page
// shortcuts (Gmail/GitHub j/k). Ctrl+V is inert instead.
test('short paste with NO known focused field stages + Ctrl+V instead of keysyms', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'paste', { clipboardData: { getData: () => 'hi there' } });
  assert.deepEqual(rfb.clipboard, ['hi there']);
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x76, true], [0x76, false], [0xffe3, false]]);
  assert.deepEqual(rfb.tapped(), []);
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

// ---- clipboard / select-all with the CANVAS focused -------------------------
// The chords above arrive on the proxy, which holds focus only while /kbd reports
// a focused remote editable. These pin the window-level capture that covers the
// rest of the time.

test('⌘A with the canvas focused still reaches the remote as Ctrl+A', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  const e = fireWindow('keydown', { key: 'a', keyCode: 65, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x61, true], [0x61, false], [0xffe3, false]]);
  assert.equal(e.defaultPrevented, true, 'no browser select-all of the viewer chrome');
  assert.equal(e.propagationStopped, true, 'noVNC must not also forward the raw ⌘ chord');
});

test('⌘C and ⌘X with the canvas focused reach the remote as Control chords', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  fireWindow('keydown', { key: 'c', keyCode: 67, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x63, true], [0x63, false], [0xffe3, false]]);
  rfb.clearKeys();
  fireWindow('keydown', { key: 'x', keyCode: 88, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x78, true], [0x78, false], [0xffe3, false]]);
});

test('⌘V with the canvas focused: chord withheld, paste event injects the LOCAL clipboard', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  const e = fireWindow('keydown', { key: 'v', keyCode: 86, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(rfb.keys, [], 'a forwarded chord would paste the REMOTE clipboard instead');
  assert.equal(e.propagationStopped, true, 'noVNC must not forward it either');
  assert.equal(e.defaultPrevented, false, 'preventDefault would cancel the paste event below');
  fireWindow('paste', { clipboardData: { getData: () => 'hi there' } });
  // No field known-focused here, so it stages rather than typing the text out as
  // keysyms the remote page would read as shortcuts.
  assert.deepEqual(rfb.clipboard, ['hi there']);
});

test('the window capture stands down while the proxy holds focus (no double-send)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'f3', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: {}, sync: {} });
  assert.equal(globalThis.document.activeElement, proxy);
  rfb.clearKeys();
  fireWindow('keydown', { key: 'a', keyCode: 65, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(rfb.keys, [], 'the proxy keydown handler owns this case');
});

test('a paste event targeted AT the proxy is left to the proxy listener', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  globalThis.document.activeElement = proxy;
  fireWindow('paste', { target: proxy, clipboardData: { getData: () => 'once' } });
  assert.deepEqual(rfb.tapped(), [], 'no second injection from the window capture');
});

// The JS-dialog sheet's prompt() renders a real local <input> in OUR document,
// and the remote is blocked on that dialog — stealing its chords sends them
// nowhere and empties the field the user is typing in.
test('a focused local field (dialog prompt) keeps its own clipboard chords', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  const localInput = globalThis.document.createElement('input');
  globalThis.document.activeElement = localInput;
  const a = fireWindow('keydown', { key: 'a', keyCode: 65, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(rfb.keys, []);
  assert.equal(a.defaultPrevented, false);
  assert.equal(a.propagationStopped, false);
  fireWindow('paste', { target: localInput, clipboardData: { getData: () => 'mine' } });
  assert.deepEqual(rfb.tapped(), [], 'the text belongs to the local field');
});

test('remote focus signal moves key focus to the proxy; blur hands it back', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'f2', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: {}, sync: {} });
  assert.equal(globalThis.document.activeElement, proxy);
  pushSignal({ editable: false });
  assert.notEqual(globalThis.document.activeElement, proxy);
});
