// layout-resize-reveal.test.mjs — in the adjustResize cell the keyboard shrinks OUR window, so
// #screen is the small box and no transform can reveal the focused field: the remote has to
// scroll. Own file: the detectors keep module-level state across tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, makeScreen, fireWindow, setVisualViewportHeight,
  pushSignal, webSockets } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const inputSock = () => webSockets.filter((s) => s.url.endsWith('/input')).at(-1);

test('a field below the reflowed fold is revealed by scrolling the remote', async () => {
  // The numbers measured on a university login page through the portal-in-WebView chain: the
  // window goes 839 -> 527, the emulated remote (and so the canvas) stays 839, the host bridge
  // reports occ=0 because nothing was occluded, and the field the user just tapped sits at y=592.
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  canvas.offsetHeight = 839;
  canvas.clientHeight = 839;
  screen.offsetHeight = 839;
  globalThis.window.innerHeight = 839;
  setVisualViewportHeight(839);
  pushSignal({
    editable: true, focusKey: 'roll', rect: { x: 85, y: 592, w: 228, h: 34 },
    rects: [{ x: 85, y: 592, w: 228, h: 34 }], vw: 412, vh: 839, sb: 0,
  });
  proxy.focus();

  const sock = inputSock();
  const before = sock.sent.length;
  globalThis.window.innerHeight = 527;
  setVisualViewportHeight(527); // layout-resize: both shrink together
  fireWindow('resize');

  const sent = sock.sent.slice(before).map((m) => JSON.parse(m));
  assert.deepEqual(sent.map((m) => m.t), ['start', 'move', 'move', 'move', 'end'],
    'a swipe, not a tap — a tap would land a caret');
  // field bottom 626 + 24 margin - 527 visible = 123px to scroll.
  assert.equal(sent[0].points[0].y - sent[4].points[0].y, 123, 'scrolled exactly the deficit');
  assert.ok(sent[0].points[0].x < 85, 'in a column clear of the field rect');
  assert.equal(screen.style.transform || '', '', 'and no local transform, which would expose background');
});

test('a second resize does not re-scroll the same field', async () => {
  const sock = inputSock();
  const before = sock.sent.length;
  fireWindow('resize');
  assert.equal(sock.sent.length, before, 'one reveal per field per keyboard open');
});
