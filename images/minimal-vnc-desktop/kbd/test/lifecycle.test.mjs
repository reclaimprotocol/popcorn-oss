// lifecycle.test.mjs — characterization: raise/dismiss keyboard lifecycle on the
// iOS path. Observables: the proxy's focus (document.activeElement) and its
// parked/on-screen position — the two things a user-visible keyboard state
// change always moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  installGlobals, freshViewer, pushSignal, fireDoc, makeScreen,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios');

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

// A viewer with a screen, a known input rect at FIELD_RECT (remote CSS px,
// 1:1 with the 390x844 canvas), and the /kbd viewport reported.
async function fieldViewer() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  return { ...v, screen };
}

function tapAt(screen, x, y) {
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
}

function proxyParked(proxy) { return proxy.style.left === '-9999px'; }

test('tap on a known input rect raises the keyboard optimistically (proxy focused, on-screen)', async () => {
  const { proxy, screen } = await fieldViewer();
  assert.ok(proxyParked(proxy), 'proxy starts parked');
  tapAt(screen, 200, 220); // inside FIELD_RECT
  assert.equal(globalThis.document.activeElement, proxy, 'proxy focused in-gesture');
  assert.ok(!proxyParked(proxy), 'proxy moved on-screen near the tap');
});

test('editable:true confirm inside the window cancels the armed dismiss — keyboard stays up', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  pushSignal({ editable: true, focusKey: 'f1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  await sleep(1700); // > DISMISS_BASE_MS (1500)
  assert.equal(globalThis.document.activeElement, proxy, 'still focused after the dismiss window');
});

test('no remote confirm -> armDismiss tears the optimistic raise back down (false hit)', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  assert.equal(globalThis.document.activeElement, proxy);
  await sleep(1700); // RTT-adaptive dismiss fires at the 1500ms default
  assert.notEqual(globalThis.document.activeElement, proxy, 'proxy blurred');
  assert.ok(proxyParked(proxy), 'proxy parked after dismiss');
});

test('a confirmed miss-tap while the keyboard is up dismisses it', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  pushSignal({ editable: true, focusKey: 'f1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(globalThis.document.activeElement, proxy);
  await sleep(200); // clear the justDismissed-style grace between events
  tapAt(screen, 30, 700); // far outside every rect — a confirmed 'miss'
  assert.notEqual(globalThis.document.activeElement, proxy, 'miss-tap dismissed the keyboard');
  assert.ok(proxyParked(proxy));
});

test('re-raise wedge fix: keyboard down but remote still reports the field focused -> tap raises again', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  pushSignal({ editable: true, focusKey: 'f1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  await sleep(200);
  tapAt(screen, 30, 700); // local miss-dismiss — does NOT blur the remote field
  assert.notEqual(globalThis.document.activeElement, proxy);
  await sleep(200); // let the post-dismiss grace lapse
  tapAt(screen, 200, 220); // same field, same focusKey — the old wedge case
  assert.equal(globalThis.document.activeElement, proxy, 're-raise on remoteFocusKey hit');
});

test('grace window: a tap immediately after dismiss is ignored', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  pushSignal({ editable: true, focusKey: 'f1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  await sleep(200);
  tapAt(screen, 30, 700); // dismiss
  tapAt(screen, 200, 220); // within the 150ms justDismissed grace — must not re-pop
  assert.notEqual(globalThis.document.activeElement, proxy, 'grace window swallowed the tap');
});

test('transient editable:false between two trues does not dismiss (350ms grace debounce)', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  pushSignal({ editable: true, focusKey: 'f1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  // Page blurs field A then async-focuses field B (validation-on-blur pattern).
  pushSignal({ editable: false, rects: [FIELD_RECT], vw: 390, vh: 844 });
  await sleep(100); // still inside the 350ms grace
  pushSignal({ editable: true, focusKey: 'f2', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  await sleep(500); // grace would have fired by now had the true not cancelled it
  assert.equal(globalThis.document.activeElement, proxy, 'field-to-field blur was seamless');
});

test('sustained editable:false while up dismisses after the grace', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  pushSignal({ editable: true, focusKey: 'f1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  pushSignal({ editable: false, rects: [FIELD_RECT], vw: 390, vh: 844 });
  await sleep(500); // > FALSE_DISMISS_GRACE_MS (350)
  assert.notEqual(globalThis.document.activeElement, proxy, 'dismissed after grace elapsed');
});

test("tap with NO rect coverage ('unknown') does not pop; a late editable:true recovery-raises", async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [] }); // no coverage anywhere
  const { proxy } = v;
  tapAt(screen, 200, 220);
  assert.notEqual(globalThis.document.activeElement, proxy, 'unknown tap must not pop optimistically');
  // The remote's authoritative confirm arrives within the tap window → recovery.
  pushSignal({ editable: true, focusKey: 'f9', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(globalThis.document.activeElement, proxy, 'recovery raise from editable:true');
});
