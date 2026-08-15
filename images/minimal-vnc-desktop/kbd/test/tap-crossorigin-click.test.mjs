// tap-crossorigin-click.test.mjs — characterization: a tap landing inside a
// cross-origin iframe is followed by an ordered compatibility mouse click.
//
// Chrome synthesizes `click` from a CDP touch tap in the MAIN frame, but not inside
// an out-of-process (cross-origin) iframe. Measured from inside reCAPTCHA's own
// frame on portal.ufrj.br: the tap delivered
//
//   pointerdown(T), touchstart(T), touchend(T)      <- no click, checkbox ignores it
//
// while a mouse click at the identical point delivered
//
//   pointerdown(T), mousedown(T), click(T)          <- checkbox activates
//
// So anything inside such a frame was untappable. The extension streams those frame
// rects as `xf` and the tap path adds the click only there — it cannot be sent for
// every tap, because in the main frame the touch already produces one and a second
// would double-fire (a re-toggle on a checkbox, a double submit on a button).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireDoc, makeScreen, pushSignal, webSockets } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { search: '?magnify=1' }); // TOUCH_INPUT on — the viewer owns taps

function touches(...pts) { return pts.map(([x, y]) => ({ clientX: x, clientY: y })); }

// The stub canvas is 1:1 with the viewport, so screen px == remote px here; the
// mapping itself is covered by the tap hit-test suite.
async function viewerWithFrames(xf, { breakRfbPointer = false } = {}) {
  const v = await freshViewer(createMockRfb);
  if (breakRfbPointer) v.rfb._handleMouseButton = undefined; // force the CDP fallback
  const screen = makeScreen();
  pushSignal({ editable: false, rects: [], vw: 390, vh: 844, pid: 'p1', xf });
  const sock = webSockets.filter((s) => s.url.endsWith('/input')).at(-1);
  assert.ok(sock, '/input socket connected');
  return { screen, sock, rfb: v.rfb };
}

const sentTypes = (sock, from) => sock.sent.slice(from).map((m) => JSON.parse(m).t);

async function tapAt(screen, x, y) {
  fireDoc('touchstart', { touches: touches([x, y]), changedTouches: touches([x, y]), target: screen });
  fireDoc('touchend', { touches: [], changedTouches: touches([x, y]), target: screen });
}

test('a tap inside a cross-origin iframe uses the ordered CDP compatibility click', async () => {
  // Rect mirrors the live reCAPTCHA anchor frame: 304x78 at (60, 260). The touch
  // cancel and compat click share the /input command queue, so a tile cannot get a
  // VNC press interleaved with a stale CDP touch position.
  const { screen, sock, rfb } = await viewerWithFrames([{ x: 60, y: 260, w: 304, h: 78 }]);
  const before = sock.sent.length;

  await tapAt(screen, 90, 299); // the checkbox, ~30px into the frame

  assert.deepEqual(rfb.pointer, [], 'does not race a raw VNC click');
  assert.ok(sentTypes(sock, before).includes('click'), 'compat click goes over the ordered CDP channel');
});

test('an unavailable VNC helper does not affect the normal ordered CDP path', async () => {
  // The private noVNC pointer helper is no longer needed when /input is healthy.
  const { screen, sock, rfb } = await viewerWithFrames([{ x: 60, y: 260, w: 304, h: 78 }], { breakRfbPointer: true });
  const before = sock.sent.length;

  await tapAt(screen, 90, 299);

  assert.equal(rfb.pointer.length, 0, 'no pointer events');
  const click = sock.sent.slice(before).map((m) => JSON.parse(m)).find((m) => m.t === 'click');
  assert.ok(click, 'uses the /input click');
  assert.equal(click.points.length, 1);
});

test('a tap OUTSIDE every cross-origin iframe sends no compat click', async () => {
  // The double-fire guard: in the main frame the touch already produces a click.
  const { screen, sock } = await viewerWithFrames([{ x: 60, y: 260, w: 304, h: 78 }]);
  const before = sock.sent.length;

  await tapAt(screen, 90, 500); // well below the frame

  assert.ok(!sentTypes(sock, before).includes('click'), 'no compat click outside the frame');
});

test('no reported frames means no compat click anywhere', async () => {
  // A page with no cross-origin iframes must behave exactly as before this change.
  const { screen, sock } = await viewerWithFrames([]);
  const before = sock.sent.length;

  await tapAt(screen, 120, 300);

  assert.ok(!sentTypes(sock, before).includes('click'), 'unchanged on ordinary pages');
});

test('one tap in a cross-origin frame produces exactly ONE activation', async () => {
  // The bug this guards: adding the compat click while still sending touchEnd meant
  // frames where Chrome DOES synthesize a click got two. On reCAPTCHA's image
  // challenge a single tap selected two tiles. The touch must end as `cancel` —
  // which Chrome never turns into a click — leaving the mouse click as the only
  // activation, regardless of what that particular frame would have done.
  const { screen, sock, rfb } = await viewerWithFrames([{ x: 60, y: 260, w: 304, h: 78 }]);
  const before = sock.sent.length;

  await tapAt(screen, 90, 299);

  const types = sentTypes(sock, before);
  assert.ok(!types.includes('end'), `touch must not END inside the frame, got ${JSON.stringify(types)}`);
  assert.ok(types.includes('cancel'), 'it is cancelled instead');
  assert.equal(sentTypes(sock, before).filter((t) => t === 'click').length, 1, 'exactly one compatibility click');
});

test('a tap outside still ends normally (the touch keeps producing its own click)', async () => {
  const { screen, sock } = await viewerWithFrames([{ x: 60, y: 260, w: 304, h: 78 }]);
  const before = sock.sent.length;

  await tapAt(screen, 90, 500);

  const types = sentTypes(sock, before);
  assert.ok(types.includes('end'), `expected a normal touch end, got ${JSON.stringify(types)}`);
  assert.ok(!types.includes('cancel'), 'not cancelled outside cross-origin frames');
});

test('the ordered CDP click maps through CSS zoom before reaching the iframe', async () => {
  const { screen, sock } = await viewerWithFrames([{ x: 0, y: 0, w: 390, h: 844 }]);
  const canvas = screen.querySelector('canvas');
  // 2x CSS zoom: the box doubles, the layout size does not.
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 780, height: 1688 });

  await tapAt(screen, 180, 400);

  const click = sock.sent.map((m) => JSON.parse(m)).find((m) => m.t === 'click');
  assert.ok(click, 'a compatibility click was sent');
  assert.deepEqual(click.points, [{ x: 90, y: 200 }], '180 display px at 2x zoom maps to 90 remote px');
});
