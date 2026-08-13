// zoom-freeze.test.mjs — characterization: a CSS zoom must freeze the remote
// framebuffer size.
//
// noVNC derives the framebuffer size it requests from getBoundingClientRect(#screen),
// and that rect includes our zoom transform — while pushEmulate sizes the CDP
// viewport from screen.offsetWidth, which transforms do NOT affect. So with
// resizeSession left on, pinching to 2.5x made noVNC ask for a framebuffer 2.5x
// bigger than the viewport CDP was rendering: the page painted into the top-left
// corner of a huge framebuffer and the rest went blank.
//
// Only RESPONSIVE pages showed it. Fit mode was immune by accident — its phase 2
// turns resizeSession off to hold the wide framebuffer — which is why the bug looked
// page-specific rather than zoom-specific. These tests pin both halves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' });
const { createFit } = await import('../fit.js');

function makeFit() {
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: true, scaleViewport: false };
  const vt = {
    resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, zoomScale: () => 1,
    setFillFloor() {}, // scale-to-fill: on by default under ?magnify=1
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
  return { fit, rfb };
}

test('zooming a responsive page freezes the remote resize', () => {
  const { fit, rfb } = makeFit();
  assert.equal(rfb.resizeSession, true, 'precondition: responsive pages leave it on');
  fit.setZoomFreeze(true);
  assert.equal(rfb.resizeSession, false, 'frozen — noVNC can no longer request a zoomed size');
});

test('returning to 1:1 re-enables it', () => {
  const { fit, rfb } = makeFit();
  fit.setZoomFreeze(true);
  fit.setZoomFreeze(false);
  assert.equal(rfb.resizeSession, true);
});

test('redundant calls are ignored (the compose runs per frame)', () => {
  const { fit, rfb } = makeFit();
  fit.setZoomFreeze(true);
  rfb.resizeSession = 'untouched';   // a second freeze must not write again
  fit.setZoomFreeze(true);
  assert.equal(rfb.resizeSession, 'untouched');
});

test('in fit mode it is a no-op — fit owns the resize state', async () => {
  const { fit, rfb } = makeFit();
  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 390, sw: 980 });
  assert.equal(fit.fitMode(), true);
  await sleep(1200); // let phase 2 land: resizeSession off, scaleViewport on
  assert.equal(rfb.resizeSession, false, 'fit phase 2 already froze it');
  fit.setZoomFreeze(true);
  fit.setZoomFreeze(false);
  // The dangerous case: unfreezing inside fit must NOT re-enable resizeSession,
  // which would shrink the wide fit framebuffer back to the viewport and undo the fit.
  assert.equal(rfb.resizeSession, false, 'still frozen — the fit survives a zoom out');
  assert.equal(fit.fitMode(), true);
});
