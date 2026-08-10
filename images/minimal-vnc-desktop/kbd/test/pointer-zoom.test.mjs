// pointer-zoom.test.mjs — characterization: mouse clicks must land where you
// clicked while the CSS zoom is applied.
//
// Zoom is a CSS transform on #screen. noVNC computes remote coordinates as
// (clientX - canvasRect.left) / display.scale, measuring the TRANSFORMED rect but
// dividing by its own untransformed scale — so at zoom 2.5 a click is reported 2.5x
// too far right and down. Our touch path maps through remoteViewport/rect.width,
// where the zoom cancels, which is why only the mouse/trackpad path misclicked (and
// tap.js deliberately passes a real pointer through to noVNC).
//
// The fix shadows clientX/clientY in the capture phase with the point that would
// have been clicked at zoom 1. These tests pin that the corrected point maps back to
// the SAME remote pixel noVNC would have computed unzoomed — the actual invariant.
//
// ONE viewport-transform for the whole file, deliberately: the stub window keeps
// every registered listener, so a second instance would rewrite the coordinates a
// second time and compound the correction. A real page has exactly one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, fireWindow } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' });
const { createViewportTransform } = await import('../viewport-transform.js');

const FB_W = 390, FB_H = 844;   // framebuffer / display size at zoom 1

let zoom = 1, pan = { x: 0, y: 0 }, degenerate = false;
// #screen's canvas, whose getBoundingClientRect reflects the CSS transform exactly
// as the browser's would: scaled about the top-left origin, then panned.
const canvas = {
  width: FB_W, height: FB_H, style: {},
  getBoundingClientRect: () => (degenerate
    ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    : {
      left: pan.x, top: pan.y,
      width: FB_W * zoom, height: FB_H * zoom,
      right: pan.x + FB_W * zoom, bottom: pan.y + FB_H * zoom,
    }),
};
const screen = { style: {}, offsetWidth: FB_W, offsetHeight: FB_H, querySelector: () => canvas };
const vt = createViewportTransform({
  getScreenElement: () => screen,
  getCurrentRect: () => null,
  getCurrentViewport: () => ({ w: FB_W, h: FB_H }),
  getLayoutResizeMode: () => false,
  getZoomedToField: () => false,
  positionMirrorBar: () => {},
  getReadableZoom: () => 2.5,
  onZoomSettled: () => {},
  getFitMode: () => false,
});
vt.installPointerZoomFix();

function setView(z, px, py) {
  degenerate = false;
  zoom = z; pan = { x: px || 0, y: py || 0 };
  vt.applyZoomSnap(z);
  assert.equal(vt.zoomScale(), z, 'precondition: the module took the zoom');
}

// What noVNC does with the event it receives: offset inside the measured rect,
// divided by ITS OWN scale — which is 1 here (no scaleViewport in play).
function novncRemotePoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// fireWindow hands the listeners its own event object and returns it, so this is
// the event AS NOVNC WOULD SEE IT — after the capture-phase rewrite.
function click(x, y) {
  return fireWindow('mousedown', { clientX: x, clientY: y });
}

test('at zoom 1 the coordinates are untouched', () => {
  setView(1, 0, 0);
  const e = click(100, 200);
  assert.equal(e.clientX, 100);
  assert.equal(e.clientY, 200);
  assert.deepEqual(novncRemotePoint(e), { x: 100, y: 200 });
});

test('zoomed in, the click maps to the remote pixel actually under the cursor', () => {
  setView(2.5, 0, 0);
  // Screen point (250, 500) sits over remote pixel (100, 200) at 2.5x.
  const p = novncRemotePoint(click(250, 500));
  assert.ok(Math.abs(p.x - 100) < 0.01, `remote x ${p.x} == 100`);
  assert.ok(Math.abs(p.y - 200) < 0.01, `remote y ${p.y} == 200`);
});

test('without the fix the same click would land far away — the reported bug', () => {
  setView(2.5, 0, 0);
  // The raw event: what noVNC saw before, and the failure the user hit — a click
  // near the top of a form landing well below it.
  const p = novncRemotePoint({ clientX: 250, clientY: 500 });
  assert.equal(p.x, 250, 'off by exactly the zoom factor');
  assert.equal(p.y, 500);
});

test('panned and zoomed: the pan needs no separate correction', () => {
  // Pan is a translate, so it is already inside rect.left/top — deriving the
  // correction from the live rect handles it for free.
  setView(2.0, -300, -120);
  // Remote (200, 300) is drawn at -300 + 200*2 = 100, -120 + 300*2 = 480.
  const p = novncRemotePoint(click(100, 480));
  assert.ok(Math.abs(p.x - 200) < 0.01, `remote x ${p.x} == 200`);
  assert.ok(Math.abs(p.y - 300) < 0.01, `remote y ${p.y} == 300`);
});

test('a mousemove is corrected too, not just the button press', () => {
  // noVNC sends pointer MOTION as well; correcting only the click would leave hover
  // states and drags (text selection, sliders) landing on the wrong element.
  setView(2.5, 0, 0);
  const e = fireWindow('mousemove', { clientX: 250, clientY: 500 });
  const p = novncRemotePoint(e);
  assert.ok(Math.abs(p.x - 100) < 0.01 && Math.abs(p.y - 200) < 0.01, 'motion maps like the click');
});

test('a zero-sized canvas leaves the event alone rather than dividing by zero', () => {
  setView(2.5, 0, 0);
  degenerate = true; // mid-teardown / before the first frame
  const e = click(250, 500);
  assert.equal(e.clientX, 250, 'untouched');
  assert.ok(isFinite(e.clientX) && isFinite(e.clientY), 'no NaN reached noVNC');
});
