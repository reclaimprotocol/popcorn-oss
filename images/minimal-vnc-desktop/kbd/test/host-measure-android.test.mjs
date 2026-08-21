// host-measure-android.test.mjs — what measure() reports on a browser that
// resizes the LAYOUT viewport when the soft keyboard opens (host/popcorn-host.js).
//
// Why this file exists: the iOS keyboard-gap fix changed measure() from
//
//   occluded = innerHeight - vv.height - vv.offsetTop
// to
//   occluded = max(layoutBaselineHeight, innerHeight) - vv.height
//
// and neither half of that is platform-gated.  The latched baseline is there
// because Safari eventually shrinks innerHeight down to the already-shrunk
// visualViewport height while the keyboard is still docked — but an Android
// browser without the VirtualKeyboard API shrinks BOTH viewports for real, and
// on that shape a latched baseline could invent a keyboard that is not there,
// or report occlusion against a frame that has already made room for the keys.
// Chrome takes the VirtualKeyboard branch and never reaches this code; Firefox
// for Android, Android WebViews, and any iframe embedded without the
// virtual-keyboard permission do reach it.
//
// So: three properties per platform shape — the reported occlusion, whether the
// iframe gets pinned, and whether the baseline can be relearned back down.
//
// No installGlobals here: this is the HOST script, which has no platform profile
// of its own — it branches on the viewport numbers it is handed, which is exactly
// what a test can vary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHostWindow } from './host-stub.mjs';

const VIEWPORT = { w: 411, h: 732 };
const KEYBOARD = 332; // 732 - 400, a plausible Pixel-class IME

/** A layered (position:fixed, full-viewport) embed with a live measurer. */
function measurer(attachOpts) {
  const h = makeHostWindow({
    iframeRect: { left: 0, top: 0, width: VIEWPORT.w, height: VIEWPORT.h },
    viewport: VIEWPORT,
  });
  h.PopcornHost.layer(h.iframe);
  const host = h.PopcornHost.attach(h.iframe, Object.assign({ childOrigin: 'https://pod.test' }, attachOpts));
  return { h, host };
}

/** The newest geometry the host posted down to the viewer. */
function geometry(h) {
  for (let i = h.posted.length - 1; i >= 0; i--) {
    if (h.posted[i].type === 'POPCORN_HOST_GEOMETRY') return h.posted[i];
  }
  return null;
}

/** Re-measure the way the browser does: mutate the viewport, fire resize. */
function resize(h, { inner, visual, offsetTop } = {}) {
  if (inner !== undefined) h.win.innerHeight = inner;
  if (visual !== undefined) h.win.visualViewport.height = visual;
  if (offsetTop !== undefined) h.win.visualViewport.offsetTop = offsetTop;
  h.fireWindow('resize');
  return geometry(h);
}

test('a layout-resize keyboard (both viewports shrink) is NOT reported as occlusion', () => {
  const { h, host } = measurer();
  // Android's default: the keyboard takes the space out of the layout viewport,
  // so the embedded viewer is already only 400px tall. Reporting 332px of
  // occlusion on top of that would lift the remote field twice.
  const g = resize(h, { inner: 400, visual: 400 });
  assert.equal(g.occludedBottom, 0, 'no phantom keyboard from the latched baseline');
  assert.equal(g.visibleHeight, 400);
  assert.equal(g.framePinned, 0, 'nothing to pin — the layout already made room');
  assert.equal(h.iframe.style.height, '100%', 'the embedder layout contract is untouched');
  host.destroy();
});

test('the baseline relearns DOWNWARD, so the shrunken layout is not a keyboard forever', () => {
  const { h, host } = measurer();
  resize(h, { inner: 400, visual: 400 });
  assert.equal(geometry(h).layoutBaselineHeight, 400, 'baseline followed the layout down');
  // Restoring the full viewport must not read as a keyboard in either direction.
  const g = resize(h, { inner: 732, visual: 732 });
  assert.equal(g.occludedBottom, 0);
  assert.equal(g.visibleHeight, 732);
  host.destroy();
});

test('either viewport update order is safe (innerHeight can land first)', () => {
  const { h, host } = measurer();
  // A resize event can fire between the two updates. The intermediate state
  // (small layout viewport, stale visual viewport) must not produce occlusion.
  let g = resize(h, { inner: 400 });
  assert.equal(g.occludedBottom, 0, 'a stale visual viewport is not a keyboard');
  g = resize(h, { visual: 400 });
  assert.equal(g.occludedBottom, 0, 'and the settled layout-resize state still is not');
  assert.equal(h.iframe.style.height, '100%');
  host.destroy();
});

test('the VirtualKeyboard API outranks the layout baseline (Android Chrome path)', () => {
  const { h, host } = measurer();
  // Chromium with allow="virtual-keyboard" reports the rect explicitly, and it
  // does so WITHOUT shrinking either viewport (overlays-content). The baseline
  // latch must not touch this branch.
  h.win.navigator.virtualKeyboard = { boundingRect: { height: 300 } };
  let g = resize(h, {});
  assert.equal(g.occludedBottom, 300, 'the keyboard rect is used verbatim');
  assert.equal(g.visibleHeight, 432, 'visible height comes off innerHeight, not the baseline');
  assert.equal(g.framePinned, 1, 'an overlaying keyboard does pin the frame');

  h.win.navigator.virtualKeyboard = { boundingRect: { height: 0 } };
  g = resize(h, {});
  assert.equal(g.occludedBottom, 0, 'an empty rect falls through to a clean dismissal');
  assert.equal(h.iframe.style.height, '100%');
  host.destroy();
});

test('a visual-only shrink IS the keyboard, on any platform', () => {
  const { h, host } = measurer();
  // interactive-widget=resizes-visual (and every iOS build): the layout viewport
  // keeps its height, only the visual one shrinks. This is the case the lift is
  // for, and the case the baseline latch has to keep alive.
  const g = resize(h, { visual: 400 });
  assert.equal(g.occludedBottom, KEYBOARD);
  assert.equal(g.visibleHeight, 400);
  assert.equal(g.framePinned, 1);
  assert.equal(h.iframe.style.height, '732px', 'the frame is pinned to its pre-keyboard box');
  host.destroy();
});

test('the baseline survives innerHeight collapsing mid-session (the iOS late shrink)', () => {
  const { h, host } = measurer();
  resize(h, { visual: 400 });
  assert.equal(geometry(h).occludedBottom, KEYBOARD);
  // Safari now drops innerHeight to the already-shrunk visual height while the
  // keys are still up. Without the latch this reads as a dismissal and the black
  // gap comes back; the answer must not change.
  resize(h, { inner: 400 });
  const g = geometry(h);
  assert.equal(g.occludedBottom, KEYBOARD, 'still a keyboard, not a dismissal');
  assert.equal(h.iframe.style.height, '732px', 'and the frame stays pinned');
  host.destroy();
});

test('KNOWN GAP: with pinning off, a late innerHeight collapse double-counts', () => {
  // The latch and the pin are one mechanism: the frame is held at its
  // pre-keyboard height, so reporting occlusion against it is correct. Turn the
  // pin off (pinKeyboardHeight:false, or an iframe that is not position:fixed)
  // and the two halves disagree — the frame follows the shrinking layout while
  // the host still reports a full keyboard height, so the viewer lifts inside a
  // box that already ends above the keys.
  //
  // Reachable only when the visual viewport shrinks BEFORE innerHeight, which is
  // the iOS ordering; a layout-resize browser (tests above) shrinks both at once
  // and never latches. Locked down as current behavior, not as desired behavior.
  const { h, host } = measurer({ pinKeyboardHeight: false });
  resize(h, { visual: 400 });
  assert.equal(h.iframe.style.height, '100%', 'pinning is off, so the box is left alone');
  // The layout viewport (and with it the fixed frame) now collapses onto the
  // keyboard edge. 390 rather than 400 only so the sample clears the 8px
  // send-dedupe and the assertions can read the fresh numbers.
  h.iframe._rect = { left: 0, top: 0, width: VIEWPORT.w, height: 390 };
  resize(h, { inner: 390, visual: 390 });
  const g = geometry(h);
  assert.equal(g.occludedBottom, 342, 'a full keyboard height is still claimed');
  assert.equal(g.framePinned, 0);
  assert.equal(g.frameHeight, 390, 'against a frame that is already keyboard-sized');
  host.destroy();
});
