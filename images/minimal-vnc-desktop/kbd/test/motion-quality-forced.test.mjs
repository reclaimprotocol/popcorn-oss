// motion-quality-forced.test.mjs — characterization: ?motionq=1 drops quality
// during a forwarded scroll even when the measured RTT looks healthy.
//
// Scroll fluidity is gated by bytes-per-frame, not round-trip. A thin downlink with
// a healthy RTT is the common mobile case, and the default latency gate never fires
// there — so every scroll frame goes at full quality and arrives as a slideshow.
// This flag exists to measure that trade on a real link; the DEFAULT (no drop on a
// fast link) is pinned by motion-quality.test.mjs.
//
// Its own file because env.js freezes the URL flags at first import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { search: '?magnify=1&motionq=1' });

const { REFINE_IDLE_MS } = await import('../quality.js');
const settled = () => sleep(REFINE_IDLE_MS + 80);

test('a forwarded scroll lowers quality on a FAST link when ?motionq=1', async () => {
  // No noteRtt() at all, so the RTT EMA is 0 — the healthiest possible reading,
  // which is exactly what suppresses the drop by default.
  const { rfb } = await freshViewer(createMockRfb);
  await settled();
  const screen = makeScreen();
  assert.equal(rfb.qualityLevel, 9, 'starts at the configured quality');

  fireDoc('touchstart', { touches: [{ clientX: 100, clientY: 400 }], changedTouches: [{ clientX: 100, clientY: 400 }], target: screen });
  fireDoc('touchmove', { touches: [{ clientX: 100, clientY: 250 }], changedTouches: [{ clientX: 100, clientY: 250 }], target: screen });

  assert.equal(rfb.qualityLevel, 6, 'lowered for the forwarded scroll despite a healthy RTT');

  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 100, clientY: 250 }], target: screen });
});
