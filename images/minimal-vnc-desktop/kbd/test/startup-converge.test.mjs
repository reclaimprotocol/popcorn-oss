// startup-converge.test.mjs — characterization: the viewer must converge on a
// working state even when the pod comes up LATE.
//
// Every startup step used to be scheduled from attach on a fixed timer and retry
// only from its own failure handler: fit's settle() at 0/800/2500ms, the /kbd and
// /input dials at ~0 with retries hung off close/error. That assumes the pod is
// reachable within a couple of seconds. Measured on a real page reload it was not
// — an 8866ms RFB handshake — and nothing re-drove any of it afterwards: the
// framebuffer stayed at the Xvnc desktop size, /kbd never opened (so the
// fit decision was never made and a legacy page stayed cropped), and every touch
// was dropped with `socket=down`. There was no path back.
//
// A supervisor now polls what "up" means and re-drives whatever is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, makeScreen, webSockets, tickIntervals, advanceClock } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const socketsFor = (suffix) => webSockets.filter((s) => s.url.endsWith(suffix));

test('a stalled socket is re-dialed by the supervisor with no external event', async () => {
  await freshViewer(createMockRfb);
  makeScreen();

  // Both channels stall the way a hung WebSocket upgrade leaves them: constructed,
  // never OPEN. Nothing fires close/error, so no retry is scheduled anywhere.
  const kbd = socketsFor('/kbd').at(-1);
  const input = socketsFor('/input').at(-1);
  kbd.readyState = 0;   // CONNECTING
  input.readyState = 0; // CONNECTING
  advanceClock(9000);   // ...and overdue: the supervisor must not abort a YOUNG
                        // handshake (doing so is what killed scrolling once).
  const kbdBefore = socketsFor('/kbd').length;
  const inputBefore = socketsFor('/input').length;

  // No 'online', no 'pageshow', no visibilitychange, no rfb event — the point is
  // that recovery does not depend on the user or the network doing anything.
  tickIntervals();

  assert.ok(socketsFor('/kbd').length > kbdBefore, '/kbd was re-dialed on its own');
  assert.ok(socketsFor('/input').length > inputBefore, '/input was re-dialed on its own');
});

test('it stops re-driving once everything is healthy', async () => {
  await freshViewer(createMockRfb);
  makeScreen();

  // The stub opens sockets instantly, so this viewer is already converged.
  const kbdBefore = socketsFor('/kbd').length;
  const inputBefore = socketsFor('/input').length;

  tickIntervals();
  tickIntervals();

  assert.equal(socketsFor('/kbd').length, kbdBefore, 'no redundant /kbd reconnects');
  assert.equal(socketsFor('/input').length, inputBefore, 'no redundant /input reconnects');
});
