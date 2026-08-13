// mirror.test.mjs — characterization: ?mirror=1 (authoritative local mirror).
// The proxy is SEEDED with the remote field's real text so the OS IME finally
// has word context; edits are value-diffed and only the delta hits the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fire, pushSignal, fireDoc, makeScreen, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS } from './mock-rfb.mjs';

installGlobals('ios', { search: '?mirror=1' });

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

// Tap-raise onto a field whose remote value is `val` (published as sync.val).
async function seededViewer(val) {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  pushSignal({ editable: true, focusKey: 'm1', rect: FIELD_RECT, hints: { tag: 'INPUT' },
    sync: { val, len: val.length }, vw: 390, vh: 844, rects: [FIELD_RECT] });
  return v;
}

// The extension publishes field text ONLY while a viewer has asked for it, so this
// opt-in frame is what makes every other test in this file possible on a real
// session — without it sync.val never arrives and the seed is empty.
test('a ?mirror=1 viewer opts in on the /kbd socket', async () => {
  const { kbdSock } = await freshViewer(createMockRfb);
  assert.ok(kbdSock);
  kbdSock.onopen({}); // the stub socket opens silently; the real one fires this
  const asks = kbdSock.sent.filter((s) => String(s).includes('"mirror"'));
  assert.deepEqual(asks.map((s) => JSON.parse(s)), [{ mirror: { on: true } }]);
});

test('raise seeds the proxy with the remote value, caret at the end', async () => {
  const { proxy } = await seededViewer('hello');
  assert.equal(proxy.value, 'hello');
  assert.equal(globalThis.document.activeElement, proxy);
});

test('editing the seeded text sends only the changed tail (value-diff)', async () => {
  const { rfb, proxy } = await seededViewer('hello');
  rfb.clearKeys();
  proxy.value = 'hello!';
  fire(proxy, 'input', { inputType: 'insertText' });
  assert.deepEqual(rfb.tapped(), keysymsFor('!'));
});

test('deleting from the seeded text value-diffs into remote Backspaces', async () => {
  const { rfb, proxy } = await seededViewer('hello');
  rfb.clearKeys();
  proxy.value = 'hel';
  fire(proxy, 'input', { inputType: 'insertText' }); // selection delete / autocorrect collapse
  assert.deepEqual(rfb.tapped(), [BS, BS]);
});

test('once typing began, a late remote value must NOT clobber the proxy', async () => {
  const { rfb, proxy } = await seededViewer('hello');
  proxy.value = 'hello x';
  fire(proxy, 'input', { inputType: 'insertText' }); // typing began — seed consumed
  // A stale sync.val from before the keystroke lands late on a slow link.
  pushSignal({ editable: true, focusKey: 'm1', rect: FIELD_RECT, hints: { tag: 'INPUT' },
    sync: { val: 'hello', len: 5 }, vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(proxy.value, 'hello x', 'user text preserved (remote is BEHIND, not diverged)');
});

test('idle reconcile: after a pause, a LONGER diverged remote value is adopted', async () => {
  const { proxy } = await seededViewer('hello');
  proxy.value = 'hello';
  fire(proxy, 'input', { inputType: 'insertText' }); // stamps lastInputAt, consumes seed
  advanceClock(2000); // > IDLE_RECONCILE_MS (1500) — user paused
  // Remote-side autofill / framework mutation produced a longer value.
  pushSignal({ editable: true, focusKey: 'm1', rect: FIELD_RECT, hints: { tag: 'INPUT' },
    sync: { val: 'hello world', len: 11 }, vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(proxy.value, 'hello world', 'remote is the source of truth once idle');
});

test('idle reconcile never snaps DOWN to a shorter remote value (keystrokes in flight)', async () => {
  const { proxy } = await seededViewer('hello');
  proxy.value = 'hello there';
  fire(proxy, 'input', { inputType: 'insertText' });
  advanceClock(2000);
  pushSignal({ editable: true, focusKey: 'm1', rect: FIELD_RECT, hints: { tag: 'INPUT' },
    sync: { val: 'hello', len: 5 }, vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(proxy.value, 'hello there', 'shorter remote = in-flight keys, not drift');
});

test('remote-driven field switch reseeds the proxy from field B\'s real value', async () => {
  const { proxy } = await seededViewer('hello'); // field m1, seeded 'hello'
  // User edits A, consuming the seed for m1.
  proxy.value = 'hello!';
  fire(proxy, 'input', { inputType: 'insertText' });
  assert.equal(proxy.value, 'hello!');
  // The page moves focus to a DIFFERENT field m2 carrying its own value while the
  // keyboard stays up. The proxy must reseed from B — not keep showing A's text
  // (which B's value-diff would then treat as B's content and corrupt).
  pushSignal({ editable: true, focusKey: 'm2', rect: FIELD_RECT, hints: { tag: 'INPUT' },
    sync: { val: 'world', len: 5 }, vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(proxy.value, 'world', 'proxy reseeded from field B, not left showing A');
});

test('sensitive fields never mirror: no seed, even with a published value', async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  pushSignal({ editable: true, focusKey: 'pw', rect: FIELD_RECT, hints: { type: 'password' },
    sync: { sensitive: true, val: 'secret', len: 6 }, vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(v.proxy.value, '', 'password field stays on the empty-proxy path');
});
