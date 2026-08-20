// geometry-observer.test.mjs — regression: the viewer must recover its viewport
// when the host changes its size WITHOUT firing any window-level event.
//
// fit.refreshAfterVisibility() was only reachable from `visibilitychange`, and
// the settle path only from `window.resize`. Both are signals about the HOST, and
// in the embedded Android/WebView flow neither is guaranteed to describe us: the
// host can resize the iframe we live in, or re-run page.reload(), and change our
// usable dimensions while the window never resized and the document was never
// hidden. Nothing fired, nothing re-measured, and the canvas kept its old height.
//
// These drive the real edge — a ResizeObserver notification on #screen — rather
// than calling refreshAfterVisibility() directly, because the gap was the WIRING,
// not the recovery routine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, fireResizeObservers, tickIntervals, resizeObservers } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // MAGNIFY on

const { createFit } = await import('../fit.js');

// GEOM_SETTLE_MS is 250; wait clear of it.
const DEBOUNCE = 400;

// Each test uses its OWN #screen dimensions. Several fits coexist in one process
// (startMagnify's 800ms and 2500ms startup retries outlive the test that made
// them), so assertions filter posts by the size they are about — and a test that
// asserts NOTHING was pushed calls restore() before it ends, putting #screen back
// to the size that fit last emulated so its late retry dedupes instead of posting
// into the next test's recorder.
function makeFit(w, h) {
  const posts = [];
  globalThis.fetch = (url, opts) => {
    if (String(url).endsWith('/emulate')) posts.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true });
  };
  const screen = { style: {}, offsetWidth: w, offsetHeight: h, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  let keyboardActive = false;
  const snaps = [];
  let zoom = 1, minZoom = 1;
  const fit = createFit({
    getRfb: () => rfb,
    getScreenElement: () => screen,
    getKeyboardActive: () => keyboardActive,
    vt: {
      resetTransform() { zoom = 1; minZoom = 1; },
      applyZoomSnap(z) { snaps.push(z); zoom = Math.max(minZoom, z); },
      minZoom: () => minZoom, zoomScale: () => zoom,
      composeScreenTransform() {}, setFillFloor() {}, clampPan() {},
    },
    setMagEligible: () => {},
    updateControlButtons: () => {},
    onNavChanged: () => {},
  });
  return {
    fit, rfb, screen, posts, snaps,
    setKeyboard: (v) => { keyboardActive = v; },
    at: (ww, hh) => posts.filter((p) => p.width === ww && p.height === hh),
    // Put #screen back to `w`x`h` — the size this fit already latched — so its
    // pending startup retries dedupe to nothing.
    restore: () => { screen.offsetWidth = w; screen.offsetHeight = h; },
  };
}

test('a host resize with no window event still converges on the new dimensions', async () => {
  const { fit, rfb, screen, posts, at } = makeFit(390, 844);
  fit.startMagnify(); // installs the observer behind the window listeners
  assert.equal(at(390, 844).length, 1, 'startup emulation at the original size');

  // The host resizes the iframe. No visibilitychange, no window.resize — the
  // window object is not even touched.
  rfb.resizeSession = false; // left frozen by whatever last ran
  screen.offsetWidth = 412;
  screen.offsetHeight = 915;
  fireResizeObservers(screen);

  assert.equal(at(412, 915).length, 0, 'not posted synchronously — it is debounced');
  await sleep(DEBOUNCE);

  assert.equal(at(412, 915).length, 1, 'exactly one refresh posted the NEW dimensions');
  assert.equal(rfb.resizeSession, true,
    'resizeSession re-enabled, so the framebuffer follows the new height');
  fit.stopGeometryWatch();
});

test('a resize burst is coalesced into a single /emulate', async () => {
  const { fit, screen, at } = makeFit(360, 800);
  fit.startMagnify();

  // A drag-resize delivers a notification per frame.
  for (let i = 1; i <= 6; i++) {
    screen.offsetWidth = 360 + i * 10;
    screen.offsetHeight = 800 + i * 10;
    fireResizeObservers(screen);
  }
  await sleep(DEBOUNCE);

  assert.equal(at(420, 860).length, 1, 'one post, at the FINAL size');
  assert.equal(at(370, 810).length, 0, 'no post for an intermediate frame');
  fit.stopGeometryWatch();
});

test('a zero-sized surface is never emulated', async () => {
  const { fit, screen, posts, restore } = makeFit(375, 812);
  fit.startMagnify();
  const before = posts.length;

  // display:none, or detached from the document mid-teardown.
  screen.offsetWidth = 0;
  screen.offsetHeight = 0;
  fireResizeObservers(screen);
  await sleep(DEBOUNCE);

  assert.equal(posts.length, before,
    'a 0x0 surface would latch a bogus emulate key the next real measure has to undo');
  fit.stopGeometryWatch();
  restore();
});

test('a hidden viewer is never emulated', async () => {
  const { fit, screen, at, restore } = makeFit(414, 896);
  fit.startMagnify();

  document.hidden = true;
  try {
    screen.offsetWidth = 500;
    screen.offsetHeight = 950;
    fireResizeObservers(screen);
    await sleep(DEBOUNCE);
    assert.equal(at(500, 950).length, 0, 'nothing pushed while hidden');
  } finally {
    document.hidden = false;
  }
  fit.stopGeometryWatch();
  restore();
});

test('a full detach stops the observer and any pending debounce', async () => {
  const { fit, screen, at, restore } = makeFit(393, 852);
  fit.startMagnify();

  const observing = () => resizeObservers.filter((o) => !o.disconnected && o.targets.indexOf(screen) >= 0);
  assert.equal(observing().length, 1, 'startMagnify installed an observer on #screen');

  // A resize lands, and the teardown happens INSIDE the debounce window — the
  // race that would otherwise let a dead session re-POST /emulate.
  screen.offsetWidth = 480;
  screen.offsetHeight = 900;
  fireResizeObservers(screen);
  fit.stopGeometryWatch();

  await sleep(DEBOUNCE);
  assert.equal(at(480, 900).length, 0, 'the pending refresh was cancelled');

  // ...and the observer itself is gone, so no later notification can revive it.
  // Asserted structurally rather than by waiting: startMagnify's own 800ms and
  // 2500ms startup retries also call settle(), so a post appearing after this
  // point would not prove the observer had fired.
  assert.equal(observing().length, 0, 'the observer was disconnected');
  restore();
});

test('sub-pixel churn is not a viewport change', async () => {
  const { fit, screen, posts, restore } = makeFit(391, 845);
  fit.startMagnify();
  const before = posts.length;

  screen.offsetWidth = 392; // 1px: DPR rounding, a scrollbar, the cover fading
  screen.offsetHeight = 846;
  fireResizeObservers(screen);
  await sleep(DEBOUNCE);

  assert.equal(posts.length, before, 'no /emulate for noise');
  fit.stopGeometryWatch();
  restore();
});

test('a change window.resize already handled is not refreshed twice', async () => {
  const { fit, screen, at } = makeFit(388, 840);
  fit.startMagnify();

  // The window path gets there first (this is what its debounced settle does).
  screen.offsetWidth = 430;
  screen.offsetHeight = 930;
  fit.refreshAfterVisibility();
  assert.equal(at(430, 930).length, 1, 'window path posted it');

  // The observer sees the same resize a moment later.
  fireResizeObservers(screen);
  await sleep(DEBOUNCE);

  assert.equal(at(430, 930).length, 1, 'still one post — the geometry stamp deduped it');
  fit.stopGeometryWatch();
});

test('without ResizeObserver it falls back to polling', async () => {
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = undefined; // older WebView
  let ctx;
  try {
    ctx = makeFit(370, 810);
    ctx.fit.startMagnify();

    ctx.screen.offsetWidth = 440;
    ctx.screen.offsetHeight = 940;
    tickIntervals();          // the fallback poll notices
    await sleep(DEBOUNCE);    // ...and schedules the same debounced refresh
  } finally {
    globalThis.ResizeObserver = saved;
  }

  assert.equal(ctx.at(440, 940).length, 1, 'the poll drove the same recovery path');
  ctx.fit.stopGeometryWatch();
});

// ---- fit mode ---------------------------------------------------------------
// Fit pins the layout to a WIDTH, so a height-only change is the soft keyboard.
// Refitting for it would re-run the whole dance and lose the user's zoom every
// time the keyboard opens.

const NO_VIEWPORT_W = 980; // fit.js's desktop-fallback layout width

async function fitted(w, h) {
  const ctx = makeFit(w, h);
  window.innerWidth = w; window.innerHeight = h;
  ctx.fit.startMagnify();
  ctx.fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: w, sw: NO_VIEWPORT_W });
  assert.equal(ctx.fit.fitMode(), true, 'entered fit');
  await sleep(1300); // let the fit dance finish
  return ctx;
}

test('fit mode: a height-only change does NOT refit', async () => {
  const ctx = await fitted(384, 830);
  const before = ctx.posts.length;
  const snapsBefore = ctx.snaps.length;

  // The soft keyboard shrinks the viewport height. Width is untouched.
  ctx.screen.offsetHeight = 500;
  fireResizeObservers(ctx.screen);
  await sleep(DEBOUNCE);

  assert.equal(ctx.posts.length, before, 'no /emulate for a keyboard-driven height change');
  assert.equal(ctx.snaps.length, snapsBefore, 'and no re-zoom — the fit was left alone');
  assert.equal(ctx.fit.fitMode(), true, 'still fitted');
  ctx.fit.stopGeometryWatch();
  ctx.restore();
});

test('fit mode: a width change DOES refit', async () => {
  const ctx = await fitted(382, 828);
  const before = ctx.posts.length;

  // The host makes the iframe wider — a real viewport change, and it invalidates
  // the pinned #screen size.
  ctx.screen.offsetWidth = 700;
  ctx.screen.offsetHeight = 828;
  window.innerWidth = 700;
  fireResizeObservers(ctx.screen);
  await sleep(1300); // debounce + the refit dance

  assert.ok(ctx.posts.length > before, 'the refit re-pushed emulation');
  ctx.fit.stopGeometryWatch();
});

test('fit mode: an observed host-only width change refits even when window geometry is stale', async () => {
  const ctx = await fitted(382, 828);
  const before = ctx.posts.length;

  // This is the embedded-WebView failure mode: the host has resized the display
  // surface, but the child window never received a resize and still reports its
  // old dimensions.
  ctx.screen.offsetWidth = 700;
  ctx.screen.offsetHeight = 828;
  assert.equal(window.innerWidth, 382, 'window geometry deliberately stays stale');
  fireResizeObservers(ctx.screen);
  await sleep(1300); // debounce + the refit dance

  assert.ok(ctx.posts.length > before,
    'the observed surface dimensions, rather than stale window.innerWidth, drove the refit');
  ctx.fit.stopGeometryWatch();
});
