// fit-tall-cap.test.mjs — a fit never lays out taller than the remote window.
//
// The remote browser keeps its window within the screen it advertises, so the
// window never grows past the boot framebuffer height (1080). A 980px no-viewport
// page on a 390x844 phone would lay out 980x2121, and only its top 1080 rows were
// drawn: a dialog centred in that viewport sat half below them. The layout height
// is capped so every row is drawn, 1:1.
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

let anchored = null;
function makeFit() {
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const vt = {
    resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, setAnchorTop: (on) => { anchored = on; },
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

test('a fit taller than the window is laid out at the window height', () => {
  window.__pcnFbCap = { w: 1920, h: 1080 };
  emulated.length = 0;
  const { fit, screen } = makeFit();
  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 390, vh: 844, sw: 980 });
  assert.equal(fit.fitMode(), true);
  const e = emulated[emulated.length - 1];
  assert.deepEqual([e.width, e.height, e.deviceScaleFactor], [980, 1080, 1]);
  assert.deepEqual([screen.style.width, screen.style.height], ['980px', '1080px']);
  assert.equal(anchored, true, 'shown from the top, not centred');
});

test('a fit within the window keeps the display aspect', () => {
  window.__pcnFbCap = { w: 1920, h: 1080 };
  emulated.length = 0;
  globalThis.window.innerWidth = 844; globalThis.window.innerHeight = 390;
  const { fit, screen } = makeFit();
  fit.handleTopDocSignal({ pid: 'p1', novp: true, vw: 844, vh: 390, sw: 980 });
  assert.equal(fit.fitMode(), true);
  const e = emulated[emulated.length - 1];
  assert.deepEqual([e.width, e.height], [980, 453]);
  assert.equal(screen.style.height, '453px');
  assert.equal(anchored, false);
  globalThis.window.innerWidth = 390; globalThis.window.innerHeight = 844;
});
