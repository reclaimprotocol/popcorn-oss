// pred-default.test.mjs — characterization: the stream is a FIXED window onto the
// remote page. A forwarded scroll sends touch to the remote and waits for frames; it
// must never translate the canvas locally.
//
// This existed as an opt-out feature ("optimistic scroll prediction"): on a slow link
// it translated the viewport-sized canvas by the un-confirmed part of the finger
// delta, which meant the stream visibly slid out of its frame and exposed the
// viewer's backdrop on EVERY scroll — the displacement tracked distance travelled,
// not speed. Worst on an inner scroll container (a filter drawer), where only that
// region of the framebuffer ever changes so the prediction could never reconcile.
// The whole mechanism is deleted; this pins that it stays deleted.
//
// Its own file because node --test gives each file a process, and these assertions
// need a viewer that was never zoomed — a one-finger drag while zoomed IS a
// legitimate local pan, which would mask what is being pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';
import { noteRtt } from '../latency.js';

installGlobals('ios', { search: '?magnify=1' });

test('a forwarded scroll never moves the canvas, even on a slow link', async () => {
  noteRtt(1200); // a link slow enough that the old prediction would have engaged
  await freshViewer(createMockRfb);
  const screen = makeScreen();

  fireDoc('touchstart', { touches: [{ clientX: 100, clientY: 700 }], changedTouches: [{ clientX: 100, clientY: 700 }], target: screen });
  for (let y = 650; y >= 300; y -= 50) {
    fireDoc('touchmove', { touches: [{ clientX: 100, clientY: y }], changedTouches: [{ clientX: 100, clientY: y }], target: screen });
  }
  assert.equal(screen.style.transform || '', '', 'the stream stayed put; the remote page does the scrolling');

  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 100, clientY: 300 }], target: screen });
  assert.equal(screen.style.transform || '', '', 'and nothing snaps back on release');
});
