// fit-rotate.test.mjs — characterization: rotating in fit mode keeps the fit AND
// the user's magnification.
//
// Reported on a non-responsive site (hanyang) viewed zoomed-in: rotating to
// landscape "loses the magnified and changes the fit mode". Cause: the rotate
// handler did exitFit() and left re-detection to the next /kbd signal, which
// re-enters with the MODE DEFAULT zoom — the whole-page overview for a
// no-viewport-meta page. So the fit came back but the magnification didn't.
//
// Now a rotate re-runs the fit dance at the new size and carries the zoom across
// as a ratio to readable. The absolute zoom MUST change (readable is
// fitLayoutW/dispW, and dispW just changed); what stays put is how magnified the
// page looks. These tests pin that, plus the two ways the wiring could regress:
// a keyboard-driven height-only resize must NOT refit, and a landscape viewport
// wider than the fit layout must exit rather than fit to nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, fireWindow } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // MAGNIFY on; innerWidth 390 < NO_VIEWPORT_W

const { createFit, ROTATE_SETTLE_MS } = await import('../fit.js');

const PORTRAIT_W = 390, PORTRAIT_H = 844;
const LANDSCAPE_W = 844, LANDSCAPE_H = 390;
const NO_VIEWPORT_W = 980; // fit.js's desktop-fallback layout width

function makeFit() {
  const screen = { style: {}, offsetWidth: PORTRAIT_W, offsetHeight: PORTRAIT_H, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const snaps = [];
  let zoom = 1, minZoom = 1;
  const vt = {
    resetTransform() { zoom = 1; minZoom = 1; },
    applyZoomSnap(z) { snaps.push(z); zoom = Math.max(minZoom, z); },
    minZoom: () => minZoom,
    zoomScale: () => zoom,
    composeScreenTransform() {},
  };
  const fit = createFit({
    getRfb: () => rfb,
    getScreenElement: () => screen,
    getKeyboardActive: () => false,
    vt,
    setMagEligible: () => {},
    updateControlButtons: () => {},
    onNavChanged: () => {},
  });
  return { fit, snaps, screen, setZoom: (z) => { zoom = z; }, setMinZoom: (z) => { minZoom = z; } };
}

function setViewport(w, h) { window.innerWidth = w; window.innerHeight = h; }

// The phase-2 callback nulls fitPhase2Timer on its first line at ~1000ms, then
// applies the zoom ~150ms later. Waiting past both means a following rotate isn't
// rejected by the "a dance is already running" guard.
const settleDance = () => sleep(1200);

test('rotate keeps fit and preserves the magnification level', async () => {
  setViewport(PORTRAIT_W, PORTRAIT_H);
  const { fit, snaps, screen, setZoom } = makeFit();

  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: PORTRAIT_W, sw: NO_VIEWPORT_W });
  assert.equal(fit.fitMode(), true, 'entered fit on the no-viewport-meta page');
  await settleDance();

  // The user zooms in to read (the magnify button's readable target).
  const readablePortrait = NO_VIEWPORT_W / PORTRAIT_W;         // 2.51
  setZoom(readablePortrait);

  setViewport(LANDSCAPE_W, LANDSCAPE_H);
  screen.offsetWidth = LANDSCAPE_W; screen.offsetHeight = LANDSCAPE_H;
  fit.refitForRotate();

  assert.equal(fit.fitMode(), true, 'still in fit after the rotate');
  await settleDance();

  // Same apparent magnification => the readable zoom for the NEW width, which is
  // a smaller number than before. The old code produced the overview instead.
  // 980/844 = 1.16, which readableZoomFor floors at 1.2 (below that, "magnified"
  // isn't worth a mode) — so the landscape readable zoom is that floor.
  const readableLandscape = Math.max(1.2, NO_VIEWPORT_W / LANDSCAPE_W);
  const applied = snaps.at(-1);
  assert.ok(Math.abs(applied - readableLandscape) < 0.02,
    `zoom carried across as a ratio: got ${applied.toFixed(3)}, want ~${readableLandscape.toFixed(3)}`);
  assert.ok(applied > 1.05, 'and it is still magnified, not the whole-page overview');
});

test('rotate from the whole-page overview stays on the overview', async () => {
  setViewport(PORTRAIT_W, PORTRAIT_H);
  const { fit, snaps, setZoom, setMinZoom } = makeFit();

  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: PORTRAIT_W, sw: NO_VIEWPORT_W });
  await settleDance();
  setMinZoom(1); setZoom(1); // zoomed out — the desktop-fit default

  setViewport(LANDSCAPE_W, LANDSCAPE_H);
  fit.refitForRotate();
  await settleDance();

  // Ratio-preserving a sub-readable zoom lands below minZoom, which the real
  // applyZoomSnap clamps back to the overview. The user does not get yanked in.
  assert.ok(snaps.at(-1) <= 1.0001, `stays at/below the fit floor (got ${snaps.at(-1).toFixed(3)})`);
});

test('landscape wider than the fit layout exits fit instead of fitting to nothing', async () => {
  setViewport(PORTRAIT_W, PORTRAIT_H);
  const { fit } = makeFit();

  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: PORTRAIT_W, sw: NO_VIEWPORT_W });
  assert.equal(fit.fitMode(), true);
  await settleDance();

  setViewport(1200, 800); // tablet landscape — wider than the 980px layout
  fit.refitForRotate();
  assert.equal(fit.fitMode(), false, 'fit dropped; the detector re-decides at the new size');
});

test('wiring: a width change refits, a keyboard height-only resize does not', async () => {
  setViewport(PORTRAIT_W, PORTRAIT_H);
  const { fit, snaps } = makeFit();
  fit.startMagnify(); // registers the resize / orientationchange listeners

  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: PORTRAIT_W, sw: NO_VIEWPORT_W });
  await settleDance();
  const before = snaps.length;

  // Soft keyboard: the layout viewport loses height, width is unchanged. Refitting
  // here would flash the cover and reset the pan on every keyboard open.
  setViewport(PORTRAIT_W, 400);
  fireWindow('resize', {});
  await sleep(ROTATE_SETTLE_MS + 100);
  assert.equal(snaps.length, before, 'height-only resize left fit alone');

  // Real rotate, arriving only as a resize (no orientationchange — devtools
  // responsive mode, and some browsers).
  setViewport(LANDSCAPE_W, LANDSCAPE_H);
  fireWindow('resize', {});
  await sleep(ROTATE_SETTLE_MS + 100);
  await settleDance();
  assert.ok(snaps.length > before, 'width change triggered the re-fit');
  assert.equal(fit.fitMode(), true, 'and stayed in fit');
});
