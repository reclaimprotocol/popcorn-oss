// tap-before-input.test.mjs — characterization: a tap must reach the remote even
// while the /input channel is still coming up.
//
// Taps are delivered over /input (CDP), which silently DROPS while its socket is
// not yet OPEN. And it opens late: measured across three device sessions, /input
// opened a consistent 4.0-4.6s AFTER the RFB handshake completed (4008 / 4331 /
// 4627ms), independent of when that handshake landed — the first full framebuffer
// is the whole 1920x1080 desktop and its transfer starves the small handshake
// queued behind it. The user therefore gets a fully live picture and taps it for
// seconds while every tap is discarded ("sent=0 dropped=7 socket=down").
//
// A visible picture means the RFB socket is open, so a tap now falls back to an
// RFB pointer event — the same X11 path a desktop mouse takes. Only while /input
// is unusable, so the two paths can never double-fire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireDoc, makeScreen, webSockets } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const inputSock = () => webSockets.filter((s) => s.url.endsWith('/input')).at(-1);

async function viewer() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  return { ...v, screen, canvas: screen.querySelector('canvas') };
}

function tapAt(canvas, x, y) {
  fireDoc('touchstart', { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
}

test('a tap while /input is still connecting goes out over VNC instead of being dropped', async () => {
  const { rfb, canvas } = await viewer();
  // The state the device logs show: RFB up (there is a picture), /input not yet.
  inputSock().readyState = 0; // CONNECTING
  rfb.pointer.length = 0;

  tapAt(canvas, 120, 300);

  assert.deepEqual(rfb.pointer.map((p) => p.mask), [0, 1, 0], 'move, press, release');
  const press = rfb.pointer.find((p) => p.mask === 1);
  assert.equal(press.x, 120, 'pressed at the tap point (canvas is 1:1 in the stub)');
  assert.equal(press.y, 300);
});

test('once /input is open the tap does NOT also go over VNC (no double-fire)', async () => {
  const { rfb, canvas } = await viewer();
  assert.equal(inputSock().readyState, 1, 'stub opens instantly');
  rfb.pointer.length = 0;

  tapAt(canvas, 120, 300);

  assert.deepEqual(rfb.pointer, [], 'the CDP channel owns the gesture');
});
