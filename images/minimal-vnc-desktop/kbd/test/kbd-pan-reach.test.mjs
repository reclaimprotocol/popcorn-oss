// kbd-pan-reach.test.mjs — characterization: reaching keyboard-occluded content.
//
// With an overlay keyboard up at zoom 1, the remote page's scroll range runs out
// with the last screenful still behind the keys (the remote viewport was sized
// for no keyboard, and resizing it is the re-emulate ping-pong fit.js avoids).
// The fix: clampPan extends the LOCAL pan range by the occlusion, and a new
// keyboard-pan gesture in tap.js reaches it — drag-up pans locally once the
// remote is at its scroll bottom (the /kbd `sb` field; 0 also covers a page with
// no scroll at all, the login-form case), everything else keeps forwarding to
// the remote, and a drag that outruns the local clamp hands off to the remote
// mid-gesture. Driven here through the host-geometry detector (the embedded
// topology where the keyboard rect can ONLY come from the embedder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fire, fireDoc, fireWindow, fireHostMessage, makeScreen,
  pushSignal, webSockets, parentMessages, setVisualViewportHeight, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { embedded: true, search: '?magnify=1&parentOrigin=https://portal.test' });

function touches(...pts) {
  return pts.map(([x, y]) => ({ clientX: x, clientY: y }));
}
function inputSock() {
  return webSockets.filter((s) => s.url.endsWith('/input')).at(-1);
}
function sentTypes(sock, from) {
  return sock.sent.slice(from).map((m) => JSON.parse(m).t);
}
function translateY(screen) {
  const m = /translate\((-?[\d.]+)px,(-?[\d.]+)px\)/.exec(screen.style.transform || '');
  return m ? parseFloat(m[2]) : 0;
}
function lastViewportMsg() {
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    if (parentMessages[i].type === 'POPCORN_VIEWPORT') return parentMessages[i];
  }
  return null;
}

// Keyboard up via the host detector (300px occlusion) + a /kbd frame keeping a
// field focused with the given remote scroll-bottom distance. The field rect
// sits near the top, so the lift is 0 and the full occlusion is pan budget.
async function kbdUpViewer(sb, sc = null) {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 544, occludedBottom: 300 });
  const state = {
    editable: true, focusKey: 'f1', rect: { x: 20, y: 100, w: 200, h: 40 },
    rects: [{ x: 20, y: 100, w: 200, h: 40 }], vw: 390, vh: 844, sb,
  };
  if (sc) state.sc = sc;
  pushSignal(state);
  return { ...v, screen, canvas };
}
function dismissViaHost() {
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 844, occludedBottom: 0 });
}

test('drag-up on an unscrollable page pans locally into the occluded sliver, clamped to it', async () => {
  const { screen, canvas } = await kbdUpViewer(0);
  const sock = inputSock();
  const before = sock.sent.length;

  fireDoc('touchstart', { touches: touches([200, 600]), changedTouches: touches([200, 600]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 590]), changedTouches: touches([200, 590]), target: canvas }); // past slop -> route
  fireDoc('touchmove', { touches: touches([200, 490]), changedTouches: touches([200, 490]), target: canvas });

  assert.equal(translateY(screen), -100, 'the view pans up with the finger, no remote round-trip');
  assert.deepEqual(sentTypes(sock, before), [], 'nothing was forwarded to the remote');

  // Outrunning the 300px budget hands the rest of the gesture to the remote.
  fireDoc('touchmove', { touches: touches([200, 240]), changedTouches: touches([200, 240]), target: canvas });
  assert.equal(translateY(screen), -300, 'the pan stops at the keyboard top edge');
  assert.ok(sentTypes(sock, before).includes('start'), 'the overrun handed off to the remote');

  fireDoc('touchend', { touches: [], changedTouches: touches([200, 240]), target: canvas });
  assert.ok(sentTypes(sock, before).includes('end'), 'the handed-off remote touch was ended');

  // Dismissal collapses the extension: the view returns from the extended strip.
  dismissViaHost();
  assert.equal(translateY(screen), 0, 'dismiss pulls the view back out of the keyboard strip');
});

test('a flicked local pan coasts past where the finger lifted (momentum), clamped to the budget', async () => {
  const { screen, canvas } = await kbdUpViewer(0); // 300px budget, unscrollable
  const move = (y) => fireDoc('touchmove', { touches: touches([200, y]), changedTouches: touches([200, y]), target: canvas });

  fireDoc('touchstart', { touches: touches([200, 600]), changedTouches: touches([200, 600]), target: canvas });
  advanceClock(16); move(584); // past slop -> routes local (drag up + remote at bottom)
  advanceClock(16); move(560); // seeds velocity samples
  advanceClock(16); move(544);
  const atRelease = translateY(screen);
  fireDoc('touchend', { touches: [], changedTouches: touches([200, 544]), target: canvas });
  const afterGlide = translateY(screen); // stub RAF is synchronous — the glide has fully run

  assert.ok(afterGlide < atRelease - 1, 'the release glided further up than the finger left it (' + atRelease + ' -> ' + afterGlide + ')');
  assert.ok(afterGlide >= -300, 'but momentum never carries past the occlusion budget');
  dismissViaHost();
  assert.equal(translateY(screen), 0, 'and a dismiss mid-rest still collapses the extension');
});

test('drag-up forwards to the remote while it can still scroll (sb large)', async () => {
  const { screen, canvas } = await kbdUpViewer(2000);
  const sock = inputSock();
  const before = sock.sent.length;

  fireDoc('touchstart', { touches: touches([200, 600]), changedTouches: touches([200, 600]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 590]), changedTouches: touches([200, 590]), target: canvas });

  assert.ok(sentTypes(sock, before).includes('start'), 'the drag went to the remote page');
  assert.equal(translateY(screen), 0, 'and applied no local transform');

  fireDoc('touchend', { touches: [], changedTouches: touches([200, 590]), target: canvas });
  assert.ok(sentTypes(sock, before).includes('end'));
  dismissViaHost();
});

test('drag-up inside a scrollable modal stays remote even when the document is at bottom', async () => {
  const { screen, canvas } = await kbdUpViewer(0, { x: 0, y: 0, w: 390, h: 844, b: 500 });
  const sock = inputSock();
  const before = sock.sent.length;

  fireDoc('touchstart', { touches: touches([200, 600]), changedTouches: touches([200, 600]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 560]), changedTouches: touches([200, 560]), target: canvas });

  assert.ok(sentTypes(sock, before).includes('start'), 'the modal still has remote scroll room');
  assert.equal(translateY(screen), 0, 'the keyboard pan did not steal the modal gesture');
  fireDoc('touchend', { touches: [], changedTouches: touches([200, 560]), target: canvas });
  dismissViaHost();
});

test('drag-down unwinds the spent budget locally, then hands off to the remote', async () => {
  const { screen, canvas } = await kbdUpViewer(0);
  const sock = inputSock();

  // Spend part of the budget first.
  fireDoc('touchstart', { touches: touches([200, 600]), changedTouches: touches([200, 600]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 592]), changedTouches: touches([200, 592]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 442]), changedTouches: touches([200, 442]), target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: touches([200, 442]), target: canvas });
  assert.equal(translateY(screen), -150, 'the pan survives the gesture end');

  // Drag back down: local unwind first (the extension is our state, no signal
  // needed), then the overrun forwards to the remote to scroll it up.
  const before = sock.sent.length;
  fireDoc('touchstart', { touches: touches([200, 300]), changedTouches: touches([200, 300]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 308]), changedTouches: touches([200, 308]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 458]), changedTouches: touches([200, 458]), target: canvas });
  assert.equal(translateY(screen), 0, 'the budget unwound to the resting position');
  assert.deepEqual(sentTypes(sock, before), [], 'without touching the remote');

  fireDoc('touchmove', { touches: touches([200, 478]), changedTouches: touches([200, 478]), target: canvas });
  assert.ok(sentTypes(sock, before).includes('start'), 'the overrun handed off to the remote');
  fireDoc('touchend', { touches: [], changedTouches: touches([200, 478]), target: canvas });
  dismissViaHost();
});

test('a deferred no-move touch is a tap: synthesized to the remote like the zoomed path', async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 544, occludedBottom: 300 });
  // No rects on purpose: the tap hit-test stays 'unknown', so this asserts only
  // the synthesis, not the raise/dismiss classification.
  pushSignal({ editable: true, focusKey: 'f2', rect: { x: 20, y: 100, w: 200, h: 40 }, vw: 390, vh: 844, sb: 0 });
  const sock = inputSock();
  const before = sock.sent.length;

  fireDoc('touchstart', { touches: touches([100, 300]), changedTouches: touches([100, 300]), target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: touches([100, 300]), target: canvas });

  assert.deepEqual(sentTypes(sock, before), ['start'],
    'the touch was never forwarded live, so the tap is synthesized on end');
  // The press is HELD ~60ms rather than released in the same tick: a
  // zero-duration tap is missed by some remote widgets (the same reason
  // focusClosestInput holds its press).
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(sentTypes(sock, before), ['start', 'end'],
    'and released after the hold, like a real finger');
  dismissViaHost();
});

test('host occ=0 heartbeats no longer blind the layout-resize detector (Firefox-nested cell)', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  makeScreen();
  // A layout-resize embedder (Firefox Android top-level) measures occluded≈0
  // forever — its own innerHeight shrinks with the visual viewport. That fresh
  // occ=0 sample used to suppress the ONE detector that can see the keyboard
  // here: the viewer's own layout resize.
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 844, occludedBottom: 0 });
  globalThis.window.innerHeight = 644;
  setVisualViewportHeight(644); // layout-resize: both shrink together
  proxy.focus();
  parentMessages.length = 0;
  fireWindow('resize');

  const msg = lastViewportMsg();
  assert.ok(msg, 'the layout detector ran despite fresh host geometry');
  assert.equal(msg.visibleHeight, 644);
  assert.equal(msg.occludedBottom, 0, 'layout already reflowed: no overlay occlusion, no pan budget');

  // Restore for any later test in this process.
  globalThis.window.innerHeight = 844;
  setVisualViewportHeight(844);
  fireWindow('resize');
});

test('rotating while typing does not false-latch layout-resize mode', async () => {
  // A soft keyboard never changes the viewport WIDTH; a rotation does. Without
  // a width guard the rotation's innerHeight drop (far past the 150px keyboard
  // threshold, with the proxy still focused because the user was typing) read
  // as a layout-resize keyboard. That latch then suppresses the lift AND zeroes
  // the pan budget, so when the keys come back the field sits behind them with
  // no way to reach it — and rotating back read as a "grow" and tore down a
  // live keyboard.
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  // Keyboard up via the host, mid-typing.
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 544, occludedBottom: 300 });
  pushSignal({
    editable: true, focusKey: 'rot', rect: { x: 20, y: 100, w: 200, h: 40 },
    rects: [{ x: 20, y: 100, w: 200, h: 40 }], vw: 390, vh: 844, sb: 0,
  });
  proxy.focus();
  // The user is mid-word. This matters: a transient occ=0 arriving within the
  // recent-input window takes the floating-keyboard KEEP branch, so the
  // keyboard stays up and the proxy stays focused — which is exactly what lets
  // the rotation resize below reach the latch.
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertText' });

  // Rotate to landscape: the IME hides transiently, so the host posts occ=0 —
  // which now passes the (occlusion-only) layout-detector suppression.
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 390, occludedBottom: 0 });
  globalThis.window.innerWidth = 844;
  globalThis.window.innerHeight = 390;
  setVisualViewportHeight(390);
  fireWindow('resize');

  // The keyboard re-shows in landscape. If the rotation had latched
  // layout-resize mode, the pan budget would be clamped to 0.
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 250, occludedBottom: 140 });
  pushSignal({
    editable: true, focusKey: 'rot', rect: { x: 20, y: 40, w: 200, h: 30 },
    rects: [{ x: 20, y: 40, w: 200, h: 30 }], vw: 844, vh: 390, sb: 0,
  });
  const before = translateY(screen);
  fireDoc('touchstart', { touches: touches([400, 200]), changedTouches: touches([400, 200]), target: canvas });
  fireDoc('touchmove', { touches: touches([400, 190]), changedTouches: touches([400, 190]), target: canvas }); // past slop -> route
  fireDoc('touchmove', { touches: touches([400, 150]), changedTouches: touches([400, 150]), target: canvas });
  assert.ok(translateY(screen) < before - 1,
    'the pan budget survived the rotation — occluded content is still reachable');
  fireDoc('touchend', { touches: [], changedTouches: touches([400, 150]), target: canvas });

  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  setVisualViewportHeight(844);
  fireWindow('resize');
  dismissViaHost();
});

test('a letterboxed canvas gets no pan extension (nothing hides behind the keys)', async () => {
  // A canvas SMALLER than the display is flex-centered by noVNC with blank #111
  // below it, so there is nothing behind the keyboard to reach. Extending there
  // would make the clamp band entirely positive, snapping the view DOWN by the
  // whole centring offset on the first drag.
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  canvas.offsetWidth = 390;
  canvas.offsetHeight = 500;   // letterboxed inside an 844px-tall display
  screen.offsetHeight = 500;
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 544, occludedBottom: 300 });
  pushSignal({
    editable: true, focusKey: 'lb', rect: { x: 20, y: 100, w: 200, h: 40 },
    rects: [{ x: 20, y: 100, w: 200, h: 40 }], vw: 390, vh: 500, sb: 0,
  });
  proxy.focus();

  // Where the centering branch parks a 500px-tall canvas in an 844px display.
  const centred = (844 - 500) / 2;
  fireDoc('touchstart', { touches: touches([200, 300]), changedTouches: touches([200, 300]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 290]), changedTouches: touches([200, 290]), target: canvas }); // past slop -> route
  fireDoc('touchmove', { touches: touches([200, 240]), changedTouches: touches([200, 240]), target: canvas });
  assert.equal(translateY(screen), centred,
    'the letterboxed view stays centred — no snap, no extension');
  fireDoc('touchend', { touches: [], changedTouches: touches([200, 240]), target: canvas });

  canvas.offsetHeight = 844;
  screen.offsetHeight = 844;
  dismissViaHost();
});

test('an absurd host occlusion is rejected rather than becoming pan budget', async () => {
  // occludedBottom doubles as the pan-extension budget, so a buggy embedder
  // posting a keyboard taller than the window could drag the canvas off-screen.
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  proxy.focus();
  parentMessages.length = 0;
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 544, occludedBottom: 5000 });
  assert.equal(lastViewportMsg(), null, 'the nonsense sample never reached the detector');

  const rest = translateY(screen);
  fireDoc('touchstart', { touches: touches([200, 300]), changedTouches: touches([200, 300]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 200]), changedTouches: touches([200, 200]), target: canvas });
  assert.equal(translateY(screen), rest, 'and granted no pan budget');
  fireDoc('touchend', { touches: [], changedTouches: touches([200, 200]), target: canvas });
  dismissViaHost();
});
