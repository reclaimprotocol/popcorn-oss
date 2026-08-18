// viewport-reload-converge.test.mjs — regression: a viewport change the viewer
// never got a resize event for must still converge on the NEW dimensions.
//
// The reported symptom is a canvas left at an old height after a page refresh or
// a host viewport change. Two things produce it, and both live on the same path:
//
//   1. kbd-autofocus.js called fit.refreshAfterVisibility() when the tab came
//      back to the foreground, and fit.js never exported such a function. The
//      call threw inside its setTimeout, so nothing was ever re-measured — the
//      one hook meant to fix a stale viewport was dead on arrival.
//   2. Re-measuring alone is not enough. An embedded viewer is hidden with
//      display:none and shown again at a different size, and a WebView does not
//      reliably emit `resize` for either transition — so the remote stays
//      emulated at the size captured before it was hidden, with resizeSession
//      left OFF from the resize-burst freeze, which is what pins the framebuffer
//      (and therefore the canvas) at the old height.
//
// Direct unit test of createFit with mock deps, same rig as
// late-connect-resettle.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // MAGNIFY on

const { createFit } = await import('../fit.js');

function makeFit(w, h) {
  const posts = [];
  globalThis.fetch = (url, opts) => {
    if (String(url).endsWith('/emulate')) posts.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true });
  };
  const screen = { style: {}, offsetWidth: w, offsetHeight: h, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const fit = createFit({
    getRfb: () => rfb,
    getScreenElement: () => screen,
    getKeyboardActive: () => false,
    vt: {
      resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, zoomScale: () => 1,
      composeScreenTransform() {}, setFillFloor() {}, clampPan() {},
    },
    setMagEligible: () => {},
    updateControlButtons: () => {},
    onNavChanged: () => {},
  });
  return { fit, rfb, screen, posts };
}

test('the visibility/resize refresh hook actually exists', () => {
  const { fit } = makeFit(390, 844);
  // It is called unconditionally from the visibilitychange handler; if it is not
  // a function that handler throws and NOTHING re-measures.
  assert.equal(typeof fit.refreshAfterVisibility, 'function');
});

test('a host viewport change with no resize event converges on the new dimensions', () => {
  const { fit, rfb, screen, posts } = makeFit(390, 844);

  fit.startMagnify(); // settle() -> first emulation at the pre-hide size
  assert.equal(posts.length, 1, 'startup emulation was pushed');
  assert.deepEqual([posts[0].width, posts[0].height], [390, 844]);

  // The viewer is hidden. A resize burst froze the remote size on the way there,
  // which is what leaves the framebuffer pinned.
  rfb.resizeSession = false;

  // It comes back at a DIFFERENT size, and no resize event is emitted.
  screen.offsetWidth = 430;
  screen.offsetHeight = 932;

  fit.refreshAfterVisibility();

  assert.equal(posts.length, 2, 're-measured and re-pushed');
  assert.deepEqual([posts[1].width, posts[1].height], [430, 932],
    'the NEW dimensions, not the ones captured before it was hidden');
  assert.equal(rfb.resizeSession, true,
    'resizeSession is back on, so the framebuffer follows the new height');
});

test('the refresh is not deduped away when the dimensions are unchanged', () => {
  const { fit, posts } = makeFit(390, 844);

  fit.pushEmulate();
  assert.equal(posts.length, 1);
  // Proof the emulate key is latched: this is what makes a naive "just call
  // pushEmulate again" recovery a silent no-op.
  fit.pushEmulate();
  assert.equal(posts.length, 1, 'an identical re-push is deduped');

  // Same numbers, but the REMOTE may have drifted (a reload dropped the override,
  // or the POST landed on a proxy whose CDP was not attached yet and still
  // answered OK). The refresh must force the push through regardless.
  fit.refreshAfterVisibility();
  assert.equal(posts.length, 2, 'the stale latch was cleared and the push forced through');
  assert.deepEqual([posts[1].width, posts[1].height], [390, 844]);
});
