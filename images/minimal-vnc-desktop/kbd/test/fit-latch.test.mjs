// fit-latch.test.mjs — characterization: auto-reconnects must not falsely latch
// fit mode. On a flaky link, 3 soft-reconnects within 30s each re-apply fit;
// before the fix those re-applications fed the ping-pong latch counter, so
// fitLatched wedged true and a later navigation to a genuinely responsive page
// could never exitFit (stuck in the 980px desktop-fit view). The reconnect
// re-apply now updates lastFitChangeAt but does NOT count toward the latch.
//
// Direct unit test of createFit with mock deps: the full-viewer path has 1000ms
// phase-2 timers and would need the whole magnify/canvas rig. The reconnect
// re-apply is gated on fitPhase2Timer clearing (first line of the phase-2
// callback), so each cycle waits ~1.1s of real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, advanceClock } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // MAGNIFY on; innerWidth 390 < NO_VIEWPORT_W

// Dynamic import AFTER installGlobals so env.js freezes MAGNIFY=true.
const { createFit } = await import('../fit.js');

function makeFit() {
  const magEligible = [];
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const vt = {
    resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, zoomScale: () => 1,
    composeScreenTransform() {},
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
  return { fit, magEligible };
}

// Wait for a just-started fit dance's phase-2 timer to clear (its callback nulls
// fitPhase2Timer on its first line at ~1000ms) so the next reconnect can re-apply.
const settleDance = () => sleep(1100);

test('a no-viewport navigation retains the current desktop fit', () => {
  const { fit } = makeFit();

  fit.handleTopDocSignal({ pid: 'hanyang-login', novp: true, vw: 390, sw: 980 });
  assert.equal(fit.fitMode(), true, 'entered the desktop fallback fit');

  // This is a real same-target navigation, not the reload caused by the initial
  // fit resize. The next Hanyang document has the same no-viewport signature and
  // must retain the existing wide framebuffer instead of flashing a narrow frame.
  advanceClock(6000);
  fit.handleTopDocSignal({ pid: 'hanyang-courses', novp: true, vw: 980, sw: 980 });

  assert.equal(fit.fitMode(), true, 'retained the desktop fit across navigation');
});

test('three auto-reconnects do not latch fit; a later navigation still exits', async () => {
  const { fit, magEligible } = makeFit();

  // Enter fit on a no-viewport-meta page.
  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 390, sw: 980 });
  assert.equal(fit.fitMode(), true, 'entered fit');
  await settleDance();

  // Three soft-reconnects, each re-applying the same fit (the flaky-3G case).
  for (let i = 0; i < 3; i++) {
    fit.reapplyFitOnReconnect();
    await settleDance();
  }
  assert.equal(fit.fitMode(), true, 'still in fit across the reconnects');

  // Now the user navigates to a genuinely responsive page, comfortably outside
  // the reload-on-resize settle window (advance the module's logical clock past
  // FIT_SETTLE_MS=4500 so only the counter-latch could hold it).
  advanceClock(6000);
  fit.handleTopDocSignal({ pid: 'p2', novp: false, vw: 390, sw: 390 });

  assert.equal(fit.fitMode(), false, 'navigation exited fit — reconnects never latched it');
  assert.equal(magEligible.at(-1), false, 'magnify button hidden on the responsive page');
});

// The latch describes the PAGE ("this one reloads when resized"), not the session —
// but nothing ever cleared it, so it survived navigation. Reported from a real
// device: load hanyang (980 fit, which latches), then navigate to Kaggle, and Kaggle
// rendered at 980 as desktop with no way back short of reloading the viewer.
test('a genuine navigation clears the latch — a latched page must not infect the next', async () => {
  const { fit } = makeFit();

  // hanyang: no viewport meta -> 980 fit.
  fit.handleTopDocSignal({ pid: 'hanyang', novp: true, vw: 390, sw: 980 });
  assert.equal(fit.fitMode(), true, 'entered the 980 desktop-fallback fit');
  await settleDance();

  // It reloads BECAUSE of our resize: a new pid inside the settle window. That is
  // what the latch exists to absorb.
  fit.handleTopDocSignal({ pid: 'hanyang-reload', novp: true, vw: 390, sw: 980 });
  assert.equal(fit.fitMode(), true, 'fit held across the resize-provoked reload');

  // Churn inside the window keeps holding it — the latch doing its job.
  fit.handleTopDocSignal({ pid: 'hanyang-reload2', novp: true, vw: 390, sw: 980 });
  assert.equal(fit.fitMode(), true, 'still held');

  // The user reads, zooms, and some seconds later navigates to a responsive site.
  // Well outside FIT_SETTLE_MS, so this cannot be a reload our resize caused.
  advanceClock(9000);
  fit.handleTopDocSignal({ pid: 'kaggle', novp: false, vw: 390, sw: 390 });

  assert.equal(fit.fitMode(), false, 'Kaggle must not inherit hanyang 980 desktop layout');
  await settleDance();

  // And the session is not poisoned the other way either: a later no-viewport page
  // can still fit, i.e. clearing the latch did not disable the feature.
  advanceClock(9000);
  fit.handleTopDocSignal({ pid: 'hanyang2', novp: true, vw: 390, sw: 980 });
  assert.equal(fit.fitMode(), true, 'a fresh no-viewport page still fits');
  await settleDance();
});
