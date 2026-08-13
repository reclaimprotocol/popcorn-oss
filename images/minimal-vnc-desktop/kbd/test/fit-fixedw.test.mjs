// fit-fixedw.test.mjs — characterization: ?fixedw=NNN fits a page that OVERFLOWS the
// phone to one CONSTANT width, and leaves every other page alone.
//
// Two properties matter, and they pull in opposite directions:
//
//  1. Selectivity. A responsive page that fits must stay native 1:1 — a downscale
//     costs crispness, so only pages that would otherwise be clipped should pay it.
//  2. Non-escalation. The old rule fit to the MEASURED scrollWidth, so re-emulating
//     wider made Pinterest lay out as desktop (sw 360 -> 1104 -> 1236), each
//     re-layout confirming the previous misdiagnosis. Fitting to a constant cannot
//     escalate however the page re-measures, which is what lets the crude
//     sw > vw * 1.15 detector be safe here.
//
// So the tests feed the exact signal sequences that ran away before, and assert the
// width does not move.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, advanceClock } from './stub-dom.mjs';

installGlobals('ios', { search: '?fixedw=560' }); // innerWidth 390 -> scale 390/560 = 0.70

const { createFit } = await import('../fit.js');
const { FIXEDW, MAGNIFY } = await import('../env.js');

function makeFit() {
  const magEligible = [];
  const emulates = [];
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const zooms = [];
  const vt = {
    resetTransform() {}, applyZoomSnap: (z) => zooms.push(z), minZoom: () => 1,
    zoomScale: () => 1, composeScreenTransform() {},
  };
  // Scoped to /emulate on purpose: kbd/diag.js POSTs debug logs to /klog through the
  // same global fetch, and those bodies are valid JSON too. An unscoped probe records
  // them, so `emulates.at(-1)` is whichever endpoint was called last — which is a log
  // line, not an emulation.
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
    setMagEligible: (v) => magEligible.push(v),
    updateControlButtons: () => {},
    onNavChanged: () => {},
  });
  return { fit, magEligible, emulates, screen, rfb, zooms };
}

const settleDance = () => sleep(1200);

// One describe: node:test runs TOP-LEVEL tests concurrently, and the emulate probe
// above is installed on globalThis.fetch — shared state. As sibling top-level tests
// they interleaved and pushed into each other's arrays (a green suite asserting the
// wrong instance's emulation). Subtests of a parent default to concurrency 1.
describe('?fixedw fixed-width rendering', () => {
  it('the flag parses and implies MAGNIFY (the fit machinery is gated on it)', () => {
    assert.equal(FIXEDW, 560);
    assert.equal(MAGNIFY, true, 'fixedw without magnify=1 would be silently inert');
  });

  it('leaves a responsive page that FITS at native 1:1', async () => {
    // The selectivity half. sw 400 vs vw 390 is under the 1.15 trigger, so nothing
    // overflows and a downscale would cost crispness for no benefit.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400 });

    assert.equal(fit.fitMode(), false, 'no fit');
    assert.equal(fit.fixedFit(), false);
    assert.equal(emulates.length, 0, 'and no re-emulation');
  });

  it('fits an overflowing responsive page to the fixed width', async () => {
    // Pinterest's login: responsive (novp false) but sw=508 against a 360 viewport,
    // part of it at a negative left offset and so unreachable.
    const { fit, emulates, screen } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 508 });

    assert.equal(fit.fitMode(), true);
    assert.equal(fit.fixedFit(), true, 'flagged as the fixed-width fit, not the 980 fallback');
    assert.equal(screen.style.width, '560px', 'fitted to FIXEDW, not to sw=508');
    // 560 * 844/390 = 1212 rows — well under the kiosk window's 2400.
    assert.equal(screen.style.height, '1212px');
    assert.equal(emulates.at(-1).width, 560);
    assert.equal(emulates.at(-1).mobile, false, 'still a Windows touch device, not a phone');
    await settleDance();
  });

  it('opens at the whole-width overview, not readable zoom', async () => {
    // The 980px desktop fallback opens zoomed IN because its overview is unreadable.
    // At 560 the overview is the point: scale 0.70 is mild and shows the full width.
    const { fit, zooms } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 508 });
    await settleDance();
    await sleep(200); // the zoom lands 150ms after phase 2

    assert.equal(zooms.at(-1), 1, 'minZoom == whole width visible');
  });

  it('fits on left-overflow even when scrollWidth says the page fits', async () => {
    // The Pinterest case, measured live: sw=393 at vw=360 is UNDER the 414 trigger,
    // so the scrollWidth detector passes the page over — while 48px of the modal
    // hangs off the left edge, unreachable (you cannot scroll left of the origin).
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 393, ol: 48 });

    assert.equal(fit.fitMode(), true, 'ol caught what sw missed');
    assert.equal(fit.fixedFit(), true);
    assert.equal(emulates.at(-1).width, 560);
    await settleDance();
  });

  it('ignores sub-threshold left overflow', async () => {
    // A few px of shadow or rounding is not clipped layout.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 380, ol: 3 });

    assert.equal(fit.fitMode(), false);
    assert.equal(emulates.length, 0);
  });

  it('a growing scrollWidth cannot escalate the width', async () => {
    // The non-escalation half, driven with the exact runaway sequence: each
    // re-measure is bigger because the previous fit made the page lay out as desktop.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 414 });
    await settleDance();
    const afterFirst = emulates.length;

    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 1104 });
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 1236 });

    assert.equal(fit.fitMode(), true);
    assert.equal(emulates.length, afterFirst, 'no further emulation — the width never moved');
    assert.equal(emulates.at(-1).width, 560);
  });

  it('a no-viewport-meta page still takes the 980px fallback, not the fixed width', async () => {
    // The flag must not swallow the novp case: a page with no viewport meta is laid
    // out by real mobile browsers at ~980 desktop, and that path also wants the
    // automatic zoom-into-field that the fixed-width one suppresses.
    const { fit, emulates } = makeFit();
    fit.handleTopDocSignal({ pid: 'h1', novp: true, vw: 390, sw: 980 });

    assert.equal(fit.fitMode(), true);
    assert.equal(fit.fixedFit(), false, 'so field-session still auto-zooms into fields here');
    assert.equal(emulates.at(-1).width, 980);
    await settleDance();
  });

  it('re-detects on a real navigation', async () => {
    // Entering is per-page, so navigating away from the overflowing page drops the
    // fit and the next page is judged on its own measurements.
    const { fit } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 360, sw: 508 });
    assert.equal(fit.fitMode(), true);
    await settleDance();

    advanceClock(6000); // well past FIT_SETTLE_MS, so this reads as a user nav
    fit.handleTopDocSignal({ pid: 'p2', novp: false, vw: 360, sw: 380 });

    assert.equal(fit.fitMode(), false, 'a page that fits is not held in the fit');
    assert.equal(fit.fixedFit(), false);
  });
});
