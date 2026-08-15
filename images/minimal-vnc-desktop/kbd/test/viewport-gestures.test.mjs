// viewport-gestures.test.mjs — characterization: client-side pinch-zoom + pan
// on the #screen transform (magnify mode). Gestures are driven through the real
// document-level touch handlers; assertions read the transform string written to
// the (stubbed) #screen element.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireDoc, makeScreen, webSockets } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { search: '?magnify=1' }); // TOUCH_INPUT on — full touch ownership

function touches(...pts) {
  return pts.map(([x, y]) => ({ clientX: x, clientY: y }));
}

async function zoomedViewer() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  // Pinch out: two fingers spread from 100px apart to 200px apart → 2x zoom.
  fireDoc('touchstart', { touches: touches([100, 300], [200, 300]), changedTouches: touches([100, 300]) });
  fireDoc('touchmove', { touches: touches([50, 300], [250, 300]), changedTouches: touches([50, 300]) });
  fireDoc('touchend', { touches: [], changedTouches: touches([50, 300]) });
  return { ...v, screen };
}

test('two-finger pinch scales #screen via CSS transform (no remote round-trip)', async () => {
  const { screen } = await zoomedViewer();
  assert.match(screen.style.transform, /scale\(2\.0000\)/);
  assert.equal(screen.style.transformOrigin, '0 0');
});

test('pinching down near the fit floor snaps cleanly back to no-zoom', async () => {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
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
  fireDoc('touchstart', { touches: touches([100, 300], [200, 300]), changedTouches: touches([100, 300]) });
  fireDoc('touchmove', { touches: touches([50, 300], [250, 300]), changedTouches: touches([50, 300]) });
  fireDoc('touchcancel', { touches: [], changedTouches: [] });
  assert.match(screen.style.transform, /scale\(2\.0000\)/); // kept, not snapped to 1
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
