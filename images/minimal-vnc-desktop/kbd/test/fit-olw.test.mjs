// fit-olw.test.mjs — characterization: fitting a page whose content is clipped off
// the LEFT, WITHOUT the ?fixedw flag.
//
// scrollWidth cannot see this at all. Measured on Pinterest's login at a 360px
// viewport: sw=400 against a 414 trigger, so it reads as "fits", while 68 elements
// sat at a negative left and the form's own rows (email, password, "Forgot
// password?") were 392px wide and sliced off the left edge. You cannot scroll left
// of the origin, so none of it was reachable.
//
// The width comes from `olw` — how wide the widest clipped piece of real content is
// — not from `ol`, how far it hangs off. That distinction is the whole design, and
// it came from a measured width sweep of that page:
//
//     emulated   ol   olw
//        360     40   392     <- clipped
//        393     34    60
//        414     34    60
//        480     34    60
//        600     34    60
//
// ol never converges (one 60px decorative element is permanently at -34), so
// "widen until ol shrinks" runs to FIT_MAX_W and re-lays the page out as desktop —
// the same runaway that fitting to sw produced. olw collapses the instant the form
// fits, so one measurement gives the answer and the re-measure confirms it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // innerWidth 390, no ?fixedw

const { createFit } = await import('../fit.js');
const { FIXEDW } = await import('../env.js');

function makeFit() {
  const emulates = [];
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const zooms = [];
  const vt = {
    resetTransform() {}, applyZoomSnap: (z) => zooms.push(z), minZoom: () => 1,
    zoomScale: () => 1, composeScreenTransform() {},
  };
  globalThis.fetch = (url, opts) => {
    if (String(url).includes('/emulate')) {
      try { emulates.push(JSON.parse(opts.body)); } catch (_) {}
    }
    return Promise.resolve({ ok: true });
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
  return { fit, emulates, screen, zooms };
}

const settleDance = () => sleep(1200);

describe('left-clip fit derived from olw (no ?fixedw)', () => {
  it('runs without the flag — that is the point of this path', () => {
    assert.equal(FIXEDW, 0);
  });

  it('fits a page whose form is clipped off the left, which sw calls "fits"', async () => {
    // The exact Pinterest signal: sw=400 is UNDER 390*1.15=448, so the sw detector
    // declines. olw=392 is what catches it.
    const { fit, emulates, screen } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 40, olw: 392 });

    assert.equal(fit.fitMode(), true, 'sw alone would have left this clipped');
    // ceil(392 * 1.05) = 412
    assert.equal(screen.style.width, '412px', 'fitted to the clipped content width + margin');
    assert.equal(emulates.at(-1).width, 412);
    assert.equal(emulates.at(-1).mobile, false, 'still a Windows touch device, not a phone');
    await settleDance();
  });

  it('the fitted width is a FIXED POINT — re-measuring there asks for nothing more', async () => {
    // The runaway that killed the sw-based rule: re-emulating wider made the page
    // lay out as desktop and the new measurement confirmed the misdiagnosis, round
    // after round. The guard here is that the fitted width is stable under
    // re-measurement, so a fresh detection at 412 (the numbers this page really
    // reports there: sw=427, ol=34, olw=60) declines. A fresh instance is used
    // deliberately — this asserts the DETECTOR converges, not that some latch
    // happens to hold the old value.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 412, sw: 427, ol: 34, olw: 60 });

    assert.equal(fit.fitMode(), false, 'converged: no second, wider fit');
    assert.equal(emulates.length, 0);
    // And the sw detector agrees at that width (427 < 412*1.15 = 473), so neither
    // signal reopens the question.
  });

  it('ignores a decorative sliver — ol alone would have fired forever', async () => {
    // ol=34 is above OL_TRIGGER(16), so the ?fixedw detector would call this
    // overflowing. Without a meaningful clipped element there is nothing to reach,
    // and fitting would cost crispness for nothing.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 34, olw: 60 });

    assert.equal(fit.fitMode(), false, 'a 60px decoration is not clipped content');
    assert.equal(emulates.length, 0);
  });

  it('leaves a page that genuinely fits at native 1:1', async () => {
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 0, olw: 0 });

    assert.equal(fit.fitMode(), false);
    assert.equal(emulates.length, 0, 'no re-emulation, no downscale');
  });

  it('takes the WIDER target when a page overflows right AND clips left', async () => {
    // Fitting to the narrower of the two would leave the other side unreachable.
    // sw=900 > 390*1.15 -> swTarget 900; olw=392 -> olTarget 412. 900 wins.
    const { fit, screen } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 900, ol: 40, olw: 392 });

    assert.equal(fit.fitMode(), true);
    assert.equal(screen.style.width, '900px', 'the right-overflow target is wider, so it wins');
    await settleDance();
  });

  it('never targets narrower than the viewport', async () => {
    // enterFit declines a layout <= the display width, so a small olw must not
    // produce a pointless no-op fit that still costs an emulate round trip.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 395, ol: 20, olw: 100 });

    assert.equal(fit.fitMode(), false, '105 < viewport 390 — nothing to widen to');
    assert.equal(emulates.length, 0);
  });

  it('caps at FIT_MAX_W so a pathological measurement cannot ask for a desktop', async () => {
    const { fit, screen } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 900, olw: 9000 });

    assert.equal(fit.fitMode(), true);
    assert.equal(screen.style.width, '1440px', 'clamped to FIT_MAX_W');
    await settleDance();
  });

  it('tolerates an old extension that reports no olw at all', async () => {
    // The signal is additive: a container running a pre-olw content script must
    // behave exactly as before rather than throwing on undefined.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 40 });

    assert.equal(fit.fitMode(), false);
    assert.equal(emulates.length, 0);
  });
});

// The zoom button is only worth a control slot when the fit actually downscales
// enough that reading needs it. Measured on a 360px phone: the 980 desktop-fallback
// fit is 2.72x (unreadable at whole width), the 412 left-clip fit is 1.14x (already
// legible, and readableZoom falls back to its 1.2 floor — a 20% step).
describe('zoom button eligibility follows the fit ratio', () => {
  function makeFitTracked() {
    const eligible = [];
    const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
    globalThis.fetch = () => Promise.resolve({ ok: true });
    const fit = createFit({
      getRfb: () => ({ resizeSession: false, scaleViewport: false }),
      getScreenElement: () => screen,
      getKeyboardActive: () => false,
      vt: { resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, zoomScale: () => 1, composeScreenTransform() {} },
      setMagEligible: (v) => eligible.push(v),
      updateControlButtons: () => {},
      onNavChanged: () => {},
    });
    return { fit, eligible };
  }

  it('hides it for a narrow left-clip fit (412 on 390 = 1.06x)', async () => {
    const { fit, eligible } = makeFitTracked();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 40, olw: 392 });
    assert.equal(fit.fitMode(), true, 'it still fits — only the button is suppressed');
    assert.equal(eligible.at(-1), false, 'zoom would be a 1.2 floor step; not worth the slot');
    await sleep(1200);
  });

  it('shows it for the 980 desktop-fallback fit (980 on 390 = 2.5x)', async () => {
    const { fit, eligible } = makeFitTracked();
    fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 390, sw: 1200 });
    assert.equal(fit.fitMode(), true);
    assert.equal(eligible.at(-1), true, 'whole width is unreadable here; zoom is the point');
    await sleep(1200);
  });
});

// Tapping a field must NOT zoom on a fit that is already readable. This is the
// property, not the branch: keyed on the downscale ratio so any future narrow fit
// inherits it without having to remember to opt out (the olw fit did not, which is
// how Pinterest started zooming on every field tap).
describe('fieldZoomWorthwhile follows the fit ratio, not the branch', () => {
  function makeFitPlain() {
    const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
    globalThis.fetch = () => Promise.resolve({ ok: true });
    return createFit({
      getRfb: () => ({ resizeSession: false, scaleViewport: false }),
      getScreenElement: () => screen,
      getKeyboardActive: () => false,
      vt: { resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, zoomScale: () => 1, composeScreenTransform() {} },
      setMagEligible: () => {}, updateControlButtons: () => {}, onNavChanged: () => {},
    });
  }

  it('no zoom with no fit at all', () => {
    assert.equal(makeFitPlain().fieldZoomWorthwhile(), false);
  });

  it('no zoom for the olw left-clip fit (412/390 = 1.06)', async () => {
    const fit = makeFitPlain();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 40, olw: 392 });
    assert.equal(fit.fitMode(), true);
    assert.equal(fit.fieldZoomWorthwhile(), false, 'zooming would re-hide the clipped edge');
    await sleep(1200);
  });

  it('no zoom for a ?fixedw-sized fit (560/390 = 1.44)', async () => {
    const fit = makeFitPlain();
    fit.enterFit(560, 508, false);
    assert.equal(fit.fitMode(), true);
    assert.equal(fit.fieldZoomWorthwhile(), false, 'readable as the overview already');
    await sleep(1200);
  });

  it('ZOOMS for the 980 desktop-fallback fit (980/390 = 2.51)', async () => {
    const fit = makeFitPlain();
    fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 390, sw: 1200 });
    assert.equal(fit.fitMode(), true);
    assert.equal(fit.fieldZoomWorthwhile(), true, 'overview unreadable; zoom is the only way to type');
    await sleep(1200);
  });
});
