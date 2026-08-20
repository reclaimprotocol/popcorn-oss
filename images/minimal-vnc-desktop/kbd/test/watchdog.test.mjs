// watchdog.test.mjs — characterization: the stuck-keyboard watchdog. If a
// dismiss signal is lost, keyboardActive wedges "up"; two consecutive 1s ticks
// with the proxy unfocused force a clean dismiss. Intervals never self-tick in
// the stub — tickIntervals() drives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, pushSignal, fireDoc, makeScreen, tickIntervals, parentMessages,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios');

// health.js dedupes each code for 30s, and module state is shared across the tests
// in a file (see test/README.md) — so a case that asserts on a report has to start
// from a clean slate or an earlier test's report silently swallows it. Imported
// AFTER installGlobals: kbd/env.js reads window at module scope.
const { resetHealth } = await import('../health.js');

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

async function raisedViewer() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  pushSignal({ editable: true, focusKey: 'w1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(globalThis.document.activeElement, v.proxy, 'raised');
  return v;
}

function proxyParked(proxy) { return proxy.style.left === '-9999px'; }

test('proxy focus lost for two ticks -> forced clean dismiss', async () => {
  const { proxy } = await raisedViewer();
  globalThis.document.activeElement = null; // OS keyboard really gone; dismiss signal lost
  tickIntervals(); // miss 1
  assert.ok(!proxyParked(proxy), 'one miss is tolerated');
  tickIntervals(); // miss 2 -> dismiss
  assert.ok(proxyParked(proxy), 'watchdog forced the dismiss');
});

test('proxy still focused -> watchdog never fires', async () => {
  const { proxy } = await raisedViewer();
  tickIntervals();
  tickIntervals();
  tickIntervals();
  assert.equal(globalThis.document.activeElement, proxy, 'healthy keyboard untouched');
  assert.ok(!proxyParked(proxy));
});

test('a single transient focus loss recovers without dismissing', async () => {
  const { proxy } = await raisedViewer();
  globalThis.document.activeElement = null;
  tickIntervals(); // miss 1
  proxy.focus();   // focus came back (e.g. the paste-button round trip)
  tickIntervals(); // miss counter resets
  globalThis.document.activeElement = null;
  tickIntervals(); // miss 1 again — still under the threshold
  proxy.focus();
  tickIntervals();
  assert.ok(!proxyParked(proxy), 'no dismiss across transient blips');
});


test('focus TAKEN by another element is reclaimed, not treated as a dismissal', async () => {
  // In an embed the page above us runs its own code — its inputs, a
  // scroll-into-view, a consent banner, an analytics widget calling focus(). Any
  // of them can pull focus out of the proxy while the user is mid-word, and the
  // watchdog used to read that as "the keyboard is gone" and tear down a live
  // session. The keyboard is still open; the focus just moved.
  const { proxy } = await raisedViewer();
  const thief = globalThis.document.createElement('input');
  globalThis.document.activeElement = thief;      // something above us took it
  tickIntervals();
  assert.equal(globalThis.document.activeElement, proxy, 'we asked for it back and got it');
  assert.ok(!proxyParked(proxy), 'and the session continues');
  tickIntervals();
  tickIntervals();
  assert.ok(!proxyParked(proxy), 'still typing, still not dismissed');
});

test('a page that keeps taking focus is eventually allowed to have it', async () => {
  // The other half: no endless tug-of-war at 1Hz with a page that really wants
  // the focus. After a bounded number of attempts the honest answer is that the
  // keyboard is not ours to hold, and a clean dismiss beats a wedged lift.
  const { proxy } = await raisedViewer();
  const thief = globalThis.document.createElement('input');
  for (let i = 0; i < 6; i++) {
    globalThis.document.activeElement = thief;    // takes it back after every reclaim
    tickIntervals();
  }
  assert.ok(proxyParked(proxy), 'gave up cleanly instead of fighting forever');
});

test('a BLURRED proxy is never re-focused — that would re-open a dismissed keyboard', async () => {
  // iOS "Done" blurs the field. Re-focusing there would pop the keyboard straight
  // back up, which is a worse bug than the one the reclaim fixes, so the reclaim
  // is limited to the case where a competing ELEMENT holds the focus.
  const { proxy } = await raisedViewer();
  globalThis.document.activeElement = null;       // blurred, nothing took it
  tickIntervals();
  assert.notEqual(globalThis.document.activeElement, proxy, 'no reclaim attempted');
  tickIntervals();
  assert.ok(proxyParked(proxy), 'dismissed on the same schedule as before');
});


test('the EMBEDDER taking focus is detected — activeElement cannot see it', async () => {
  // The cross-frame case, and the one that actually happens in the portal. Each
  // document owns its own activeElement, so when the page above us focuses one of
  // ITS elements, our proxy is still this document's activeElement — the watchdog
  // sees a healthy keyboard while the browser quietly closes it. Only
  // document.hasFocus() tells the two apart.
  //
  // Nothing is torn down here: we cannot know whether the keyboard survived, and
  // re-focusing across frames without a user gesture cannot re-open one anyway. It
  // is REPORTED, because it is an embedder bug that only the embedder can fix and
  // nothing else in the stack would ever mention it.
  const { proxy } = await raisedViewer();
  resetHealth();
  parentMessages.length = 0;
  globalThis.document.hasFocus = () => false;      // the portal focused its own input
  tickIntervals();
  assert.equal(globalThis.document.activeElement, proxy, 'our element still holds it locally');
  assert.ok(!proxyParked(proxy), 'and nothing was torn down on a guess');
  const health = parentMessages.filter((m) => m.type === 'POPCORN_KBD_HEALTH');
  assert.ok(health.some((m) => m.code === 'focus-stolen'),
    'the embedder is told: ' + JSON.stringify(parentMessages.map((m) => m.type)));
  globalThis.document.hasFocus = () => true;
});
