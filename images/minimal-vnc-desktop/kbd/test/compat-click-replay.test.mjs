// compat-click-replay.test.mjs — a tap the browser never turned into a click leaves a
// click-activated control dead (measured on an iCheck-styled checkbox: pointer+touch events
// arrived, no click, no toggle). The extension reports the miss as `nc`; the viewer replays
// the click over the same ordered CDP queue the cross-origin compat click uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, makeScreen, pushSignal, webSockets } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const inputSock = () => webSockets.filter((s) => s.url.endsWith('/input')).at(-1);
const sentSince = (sock, from) => sock.sent.slice(from).map((m) => JSON.parse(m));

test('a reported no-click tap is replayed as a click at the same remote point', async () => {
  await freshViewer(createMockRfb);
  makeScreen();
  pushSignal({ editable: false, vw: 360, vh: 746, rects: [] });
  const sock = inputSock();
  const before = sock.sent.length;

  pushSignal({ editable: false, vw: 360, vh: 746, rects: [], nc: { x: 48, y: 345 } });

  const sent = sentSince(sock, before);
  assert.deepEqual(sent.map((m) => m.t), ['click'], 'exactly one compat click, nothing else');
  assert.deepEqual(sent[0].points, [{ x: 48, y: 345 }], 'at the point the tap landed');
});

test('an ordinary signal replays nothing', async () => {
  await freshViewer(createMockRfb);
  makeScreen();
  pushSignal({ editable: false, vw: 360, vh: 746, rects: [] });
  const sock = inputSock();
  const before = sock.sent.length;
  pushSignal({ editable: true, focusKey: 'f1', rect: { x: 37, y: 225, w: 270, h: 34 },
    hints: {}, sync: {}, vw: 360, vh: 746, rects: [{ x: 37, y: 225, w: 270, h: 34 }] });
  assert.deepEqual(sentSince(sock, before).map((m) => m.t), [], 'no click without nc');
});
