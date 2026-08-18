// socket-stall.test.mjs — characterization: a STALLED WebSocket connect must not
// wedge the /kbd and /input channels.
//
// Both channels retried only from their close/error handlers. A WebSocket upgrade
// that hangs fires NEITHER, so a stalled connect sat forever with nothing
// scheduling a retry — and the two "kick" paths that exist to break exactly this
// were no-ops, because each guarded on `if (!sock)` and a stalled socket is
// truthy. Measured on an embedded viewer: both channels began dialing at 314ms;
// /input opened at 8.8s and /kbd at 13.4s, and every gesture in between was
// dropped (`sent=0 dropped=7 socket=down`) while the stream looked fully live.
//
// A kick now replaces a socket stuck in CONNECTING — but ONLY once it is
// genuinely OVERDUE. Replacing a young handshake is just as broken in the other
// direction: an early version tore down every in-flight connect, so on a link
// where the upgrade legitimately takes ~4s the socket could never open at all and
// scrolling (which has no fallback path) died completely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireWindow, makeScreen, webSockets, advanceClock } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const socketsFor = (suffix) => webSockets.filter((s) => s.url.endsWith(suffix));

test('a kick replaces a /kbd socket still stuck in CONNECTING', async () => {
  await freshViewer(createMockRfb);
  makeScreen();

  const before = socketsFor('/kbd');
  const stalled = before.at(-1);
  assert.ok(stalled, 'the viewer dialed /kbd at startup');
  // The stub opens instantly; put it back into the state a hung upgrade leaves.
  stalled.readyState = 0; // CONNECTING
  advanceClock(9000);     // ...and past the connect deadline

  fireWindow('online'); // the network-back kick

  const after = socketsFor('/kbd');
  assert.equal(after.length, before.length + 1, 'the stalled connect was re-dialed');
  assert.equal(stalled.readyState, 3, 'and the stalled socket was closed (CLOSED)');
});

test('a kick replaces an /input socket still stuck in CONNECTING', async () => {
  await freshViewer(createMockRfb);
  makeScreen();

  const before = socketsFor('/input');
  const stalled = before.at(-1);
  assert.ok(stalled, 'the viewer dialed /input at startup (magnify)');
  stalled.readyState = 0; // CONNECTING
  advanceClock(9000);     // ...and past the connect deadline

  fireWindow('online');

  const after = socketsFor('/input');
  assert.equal(after.length, before.length + 1, 'the stalled touch channel was re-dialed');
  assert.equal(stalled.readyState, 3, 'and the stalled socket was closed (CLOSED)');
});

test('a healthy open socket is left alone by a kick', async () => {
  await freshViewer(createMockRfb);
  makeScreen();

  const kbdBefore = socketsFor('/kbd').length;
  const inputBefore = socketsFor('/input').length;

  fireWindow('online'); // sockets are OPEN in the stub — nothing to rescue

  assert.equal(socketsFor('/kbd').length, kbdBefore, 'no redundant /kbd reconnect');
  assert.equal(socketsFor('/input').length, inputBefore, 'no redundant /input reconnect');
});

test('a YOUNG connect is left alone — a slow link must be allowed to finish', async () => {
  await freshViewer(createMockRfb);
  makeScreen();

  // Mid-handshake, well inside the deadline. This is the common case on a phone
  // behind the framebuffer transfer, and tearing it down here is what broke
  // scrolling: the socket was re-dialed forever and never opened.
  const kbd = socketsFor('/kbd').at(-1);
  const input = socketsFor('/input').at(-1);
  kbd.readyState = 0;
  input.readyState = 0;
  const kbdBefore = socketsFor('/kbd').length;
  const inputBefore = socketsFor('/input').length;

  advanceClock(400); // nowhere near the deadline
  fireWindow('online');

  assert.equal(socketsFor('/kbd').length, kbdBefore, '/kbd handshake was not aborted');
  assert.equal(socketsFor('/input').length, inputBefore, '/input handshake was not aborted');
  assert.equal(kbd.readyState, 0, 'still connecting, not closed');
  assert.equal(input.readyState, 0, 'still connecting, not closed');
});
