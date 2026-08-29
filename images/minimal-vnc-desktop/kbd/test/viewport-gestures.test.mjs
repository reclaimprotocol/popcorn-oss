// viewport-gestures.test.mjs — characterization: native two-finger forwarding,
// with client-side pinch-zoom + pan as the offline fallback. Gestures are driven
// through the real document-level touch handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireDoc, makeScreen, webSockets, pushSignal } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { search: '?magnify=1' }); // TOUCH_INPUT on — full touch ownership

function touches(...pts) {
  return pts.map(([x, y]) => ({ clientX: x, clientY: y }));
}

async function zoomedViewer() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  // Force the documented offline fallback instead of the native /input route.
  webSockets.filter((s) => s.url.endsWith('/input')).at(-1).readyState = 0;
  // Pinch out: two fingers spread from 100px apart to 200px apart → 2x zoom.
  fireDoc('touchstart', { touches: touches([100, 300], [200, 300]), changedTouches: touches([100, 300]) });
  fireDoc('touchmove', { touches: touches([50, 300], [250, 300]), changedTouches: touches([50, 300]) });
  fireDoc('touchend', { touches: [], changedTouches: touches([50, 300]) });
  return { ...v, screen };
}

test('two-finger pinch scales #screen only when the native channel is unavailable', async () => {
  const { screen } = await zoomedViewer();
  assert.match(screen.style.transform, /scale\(2\.0000\)/);
  assert.equal(screen.style.transformOrigin, '0 0');
});

test('pinching down near the fit floor snaps cleanly back to no-zoom', async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  webSockets.filter((s) => s.url.endsWith('/input')).at(-1).readyState = 0;
  fireDoc('touchstart', { touches: touches([50, 300], [250, 300]), changedTouches: touches([50, 300]) });
  // Fingers close to 51% of start distance → scale 0.51 clamps to minZoom 1;
  // 1 < 1*1.06 so endPinch snaps to exactly the floor.
  fireDoc('touchmove', { touches: touches([100, 300], [202, 300]), changedTouches: touches([100, 300]) });
  fireDoc('touchend', { touches: [], changedTouches: touches([100, 300]) });
  assert.doesNotMatch(screen.style.transform, /scale/); // scale 1 emits no scale() part
});

test('single finger while zoomed pans locally and clamps to content bounds', async () => {
  const { screen } = await zoomedViewer();
  const before = screen.style.transform;
  fireDoc('touchstart', { touches: touches([200, 400]), changedTouches: touches([200, 400]) });
  fireDoc('touchmove', { touches: touches([150, 350]), changedTouches: touches([150, 350]) });
  fireDoc('touchend', { touches: [], changedTouches: touches([150, 350]) });
  const after = screen.style.transform;
  assert.notEqual(after, before); // view moved
  assert.match(after, /scale\(2\.0000\)/); // zoom level untouched by the pan
  // Clamp: content is 780x1688 vs 390x844 display — translate must stay in
  // [-390..0] x [-844..0] (no blank gutters).
  const m = after.match(/translate\((-?[\d.]+)px,(-?[\d.]+)px\)/);
  assert.ok(m, 'translate present: ' + after);
  assert.ok(parseFloat(m[1]) <= 0 && parseFloat(m[1]) >= -390, 'panX clamped: ' + m[1]);
  assert.ok(parseFloat(m[2]) <= 0 && parseFloat(m[2]) >= -844, 'panY clamped: ' + m[2]);
});

test('touchcancel settles the gesture without losing the zoom level', async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  webSockets.filter((s) => s.url.endsWith('/input')).at(-1).readyState = 0;
  fireDoc('touchstart', { touches: touches([100, 300], [200, 300]), changedTouches: touches([100, 300]) });
  fireDoc('touchmove', { touches: touches([50, 300], [250, 300]), changedTouches: touches([50, 300]) });
  fireDoc('touchcancel', { touches: [], changedTouches: [] });
  assert.match(screen.style.transform, /scale\(2\.0000\)/); // kept, not snapped to 1
});

test('two fingers are forwarded to the remote website when /input is ready', async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const inputSock = webSockets.filter((s) => s.url.endsWith('/input')).at(-1);
  const before = inputSock.sent.length;
  fireDoc('touchstart', { touches: touches([100, 300], [200, 300]), changedTouches: touches([100, 300]), target: screen });
  fireDoc('touchmove', { touches: touches([50, 300], [250, 300]), changedTouches: touches([50, 300]), target: screen });
  fireDoc('touchend', { touches: [], changedTouches: touches([50, 300], [250, 300]), target: screen });
  const messages = inputSock.sent.slice(before).map((message) => JSON.parse(message));
  assert.equal(messages[0].t, 'start');
  assert.equal(messages[0].points.length, 2);
  assert.ok(messages.some((message) => message.t === 'move' && message.points.length === 2));
  assert.equal(messages.at(-1).t, 'end');
});

test('single finger NOT zoomed forwards native touch to the /input channel (no pan)', async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const { webSockets } = await import('./stub-dom.mjs');
  const inputSock = webSockets.filter((s) => s.url.endsWith('/input')).at(-1); // this viewer's socket
  assert.ok(inputSock, '/input socket connected in magnify');
  const before = inputSock.sent.length;
  fireDoc('touchstart', { touches: touches([100, 200]), changedTouches: touches([100, 200]), target: screen });
  assert.ok(inputSock.sent.length > before, 'touch start forwarded');
  assert.equal(JSON.parse(inputSock.sent[inputSock.sent.length - 1]).t, 'start');
  fireDoc('touchend', { touches: [], changedTouches: touches([100, 200]), target: screen });
  assert.equal(screen.style.transform || '', ''); // no local transform at zoom 1
});

// Fit-to-width and tap-to-field zoom are the VIEWER's zoom, and the remote page
// cannot pinch out of them (its viewport meta is pinned). Above the zoom floor
// the pinch stays local, native channel or not.
test('pinch stays local when the viewer owns the zoom, native channel or not', async () => {
  const { screen } = await zoomedViewer();
  assert.match(screen.style.transform, /scale\(2\.0000\)/, 'setup: viewer is zoomed in');

  const inputSock = webSockets.filter((s) => s.url.endsWith('/input')).at(-1);
  inputSock.readyState = 1; // the native touch channel comes back
  const before = inputSock.sent.length;

  // Pinch in: fingers converge from 200px apart to 100px apart.
  fireDoc('touchstart', { touches: touches([50, 300], [250, 300]), changedTouches: touches([50, 300]), target: screen });
  fireDoc('touchmove', { touches: touches([100, 300], [200, 300]), changedTouches: touches([100, 300]), target: screen });
  fireDoc('touchend', { touches: [], changedTouches: touches([100, 300], [200, 300]), target: screen });

  // Back at the floor the viewer drops the transform entirely, so "no scale" is 1.
  const match = /scale\(([\d.]+)\)/.exec(screen.style.transform);
  const scale = match ? Number(match[1]) : 1;
  assert.ok(scale < 2, `pinch did not zoom out locally (scale stayed ${scale})`);
  const forwarded = inputSock.sent.slice(before).map((m) => JSON.parse(m))
    .filter((m) => (m.points || []).length === 2);
  assert.deepEqual(forwarded, [], 'the pinch was forwarded to a page that cannot zoom');
});

// Gesture routing needs to see fit mode, which owns the presentation whatever
// the current zoom is — including at the floor, where a zoom test alone reads as
// "not ours". Direct unit test of the accessor: entering fit through the full
// viewer needs the whole magnify/canvas rig plus its 1000ms phase-2 timers (see
// fit-latch.test.mjs).
test('gesture routing can see fit mode, whatever the zoom', async () => {
  const { createViewportTransform } = await import('../viewport-transform.js');
  const make = (fit) => createViewportTransform({
    getScreenElement: () => null,
    getCurrentRect: () => null,
    getCurrentViewport: () => null,
    getLayoutResizeMode: () => false,
    getZoomedToField: () => false,
    positionMirrorBar: () => {},
    getReadableZoom: () => 1,
    onZoomSettled: () => {},
    getFitMode: () => fit,
  });
  const fitting = make(true);
  assert.equal(fitting.fitMode(), true);
  assert.equal(fitting.zoomScale(), fitting.minZoom(), 'at the floor, where the old rule gave up');
  assert.equal(make(false).fitMode(), false);
});
