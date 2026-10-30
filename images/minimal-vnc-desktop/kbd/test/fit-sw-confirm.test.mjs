// fit-sw-confirm.test.mjs — right overflow must be confirmed before it fits.
//
// A page can render one frame wider than it settles. Measured on a live mobile
// layout: a 310px swipe drawer is laid out to the left of a 402px view, so the first
// frame measures sw=712, and the page then scrolls past the drawer and measures
// sw=402. Fitting to that first frame re-laid the page out 712 wide and opened it
// zoomed in from the left, cropping the header's right-hand button. The content
// script confirms the overflow with a fresh measurement (swc); the viewer waits for it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

describe('right-overflow fit waits for the content script to confirm it', () => {
  it('does not fit right overflow that is not yet confirmed', () => {
    const { fit } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 1200 });
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 1200 }); // heartbeat resend
    assert.equal(fit.fitMode(), false);
  });

  it('fits once a measurement confirms it', () => {
    const { fit, screen } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 1200 });
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 1200, swc: true });
    assert.equal(fit.fitMode(), true);
    assert.equal(screen.style.width, '1200px');
  });

  it('does not fit a page that settles to the screen width', () => {
    const { fit } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 700 });
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 390 });
    assert.equal(fit.fitMode(), false);
  });

  it('still fits content clipped off the left at once', () => {
    const { fit } = makeFit();
    fit.handleTopDocSignal({ pid: 'p1', novp: false, vw: 390, sw: 400, ol: 40, olw: 392 });
    assert.equal(fit.fitMode(), true);
  });
});
