// fit-tall-scale.test.mjs — a fit taller than the remote window renders scaled.
//
// The remote browser keeps its window within the screen it advertises, so the
// window never grows past the boot framebuffer height (1080). A 980px no-viewport
// page on a 390x844 phone lays out 980x2121; at 1:1 only its top 1080 rows were
// drawn, and a dialog centred in that viewport sat half below them. The layout
// must keep its full CSS size and render at a scale factor that fits the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // innerWidth 390, innerHeight 844

const emulated = [];
globalThis.fetch = (url, init) => {
  if (String(url).endsWith('/emulate') && init && init.body) emulated.push(JSON.parse(init.body));
  return Promise.resolve({ ok: true });
};

const { createFit } = await import('../fit.js');

function makeFit() {
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const vt = {
    resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1,
    zoomScale: () => 1, composeScreenTransform() {},
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
  return { fit, screen };
}

test('a fit taller than the window renders the full layout at a scale that fits', () => {
  window.__pcnFbCap = { w: 1920, h: 1080 };
  emulated.length = 0;
  const { fit, screen } = makeFit();
  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 390, vh: 844, sw: 980 });
  assert.equal(fit.fitMode(), true);
  const e = emulated[emulated.length - 1];
  assert.equal(e.width, 980, 'the page keeps its 980px layout');
  assert.equal(e.height, 2121, 'and the full phone-aspect height');
  assert.equal(e.deviceScaleFactor, 1, 'the page keeps its devicePixelRatio');
  assert.ok(Math.abs(e.scale - 1080 / 2121) < 1e-9, `scale=${e.scale}`);
  assert.equal(screen.style.height, '1080px', 'the framebuffer fits the window');
  assert.equal(screen.style.width, Math.floor(980 * 1080 / 2121) + 'px');
});

test('a fit within the window stays 1:1', () => {
  window.__pcnFbCap = { w: 1920, h: 1080 };
  emulated.length = 0;
  globalThis.window.innerWidth = 844; globalThis.window.innerHeight = 390;
  const { fit, screen } = makeFit();
  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 844, vh: 390, sw: 980 });
  assert.equal(fit.fitMode(), true);
  const e = emulated[emulated.length - 1];
  assert.equal(e.deviceScaleFactor, 1);
  assert.equal(e.scale, undefined);
  assert.equal(screen.style.width, '980px');
  globalThis.window.innerWidth = 390; globalThis.window.innerHeight = 844;
});
