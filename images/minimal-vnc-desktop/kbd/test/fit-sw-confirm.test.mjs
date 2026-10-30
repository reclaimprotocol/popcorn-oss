// fit-sw-confirm.test.mjs — right overflow must last before it fits.
//
// A page can render one frame wider than it settles. Measured on a live mobile
// layout: a 310px swipe drawer is laid out to the left of a 402px view, so the first
// frame measures sw=712, and the page then scrolls past the drawer and measures
// sw=402. Fitting to that first frame re-laid the page out 712 wide and opened it
// zoomed in from the left, cropping the header's right-hand button.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // innerWidth 390, no ?fixedw

const { createFit } = await import('../fit.js');

function makeFit() {
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const vt = {
    resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1,
    zoomScale: () => 1, composeScreenTransform() {},
  };
  globalThis.fetch = () => Promise.resolve({ ok: true });
  const fit = createFit({
    getRfb: () => rfb,
    getScreenElement: () => screen,
    getKeyboardActive: () => false,
    vt,
    setMagEligible: () => {},
    updateControlButtons: () => {},
    onNavChanged: () => {},
  });
  return { fit, screen };
}

describe('right-overflow fit waits for the overflow to last', () => {
  it('fits a page that stays too wide, once the wait is over', async () => {
    const { fit, screen } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 1200 });
    assert.equal(fit.fitMode(), false, 'not on the first measurement');
    await sleep(1150);
    assert.equal(fit.fitMode(), true);
    assert.equal(screen.style.width, '1200px');
    await sleep(1200);
  });

  it('does not fit a page that settles to the screen width', async () => {
    const { fit } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 700 });
    await sleep(300);
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 390 });
    await sleep(1000);
    assert.equal(fit.fitMode(), false);
  });

  it('starts the wait over on a new document', async () => {
    const { fit } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 1200 });
    await sleep(700);
    fit.handleTopDocSignal({ pid: 'p2', novp: false, vw: 390, sw: 1200 });
    await sleep(500);
    assert.equal(fit.fitMode(), false, 'p2 has not been too wide for long enough');
    await sleep(650);
    assert.equal(fit.fitMode(), true);
    await sleep(1200);
  });

  it('still fits content clipped off the left at once', async () => {
    const { fit } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 40, olw: 392 });
    assert.equal(fit.fitMode(), true);
    await sleep(1200);
  });
});
