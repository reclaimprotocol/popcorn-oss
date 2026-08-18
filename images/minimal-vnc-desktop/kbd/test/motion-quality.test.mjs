// motion-quality.test.mjs — characterization: motion-adaptive JPEG quality.
//
// A forwarded touch-scroll re-encodes big framebuffer regions every frame; on a
// thin uplink it's frame SIZE, not RTT, that gates fluidity. While a forwarded
// scroll is in flight on a slow link we drop rfb.qualityLevel so more frames fit,
// then restore full quality ~300ms after the finger stops. Fast links keep full
// quality (the drop would be pure downside). The motion signal is the /input
// touchmove chokepoint (noteRemoteScroll), so it never fires for client pinch/pan.
//
// linkLatency() is process-shared (latency.js): this file owns its slow-link
// seeding, and the fast-link test runs FIRST while the EMA is still 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';
import { noteRtt } from '../latency.js';

// Every connect now starts at COLD_QUALITY and steps up to the configured quality
// after REFINE_IDLE_MS (progressive refinement — see quality.js). These tests are
// about the MOTION path, so they wait for that to settle first; the refinement cycle
// itself is pinned in quality-refine.test.mjs.
const settled = async () => { await sleep(REFINE_IDLE_MS + 80); };

installGlobals('ios', { search: '?magnify=1' }); // TOUCH_INPUT on (single-finger scroll forwards)

// quality.js logs through diag.js, whose graph reads `window` at init — so it must
// be imported AFTER installGlobals (same reason as ctrl-drag.test.mjs).
const { REFINE_IDLE_MS } = await import('../quality.js');

// A single-finger drag on #screen at base zoom = a forwarded remote scroll.
function scroll(screen, fromY, toY) {
  fireDoc('touchstart', { touches: [{ clientX: 100, clientY: fromY }], changedTouches: [{ clientX: 100, clientY: fromY }], target: screen });
  fireDoc('touchmove', { touches: [{ clientX: 100, clientY: toY }], changedTouches: [{ clientX: 100, clientY: toY }], target: screen });
}
function release(screen, y) {
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 100, clientY: y }], target: screen });
}

// Runs FIRST, before any noteRtt: linkLatency is 0 (fast) — quality must stay crisp.
test('fast link: a forwarded scroll does NOT touch quality', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  await settled();
  const screen = makeScreen();
  scroll(screen, 400, 250);
  assert.equal(rfb.qualityLevel, 9, 'fast link keeps the configured quality');
  release(screen, 250);
});

test('slow link: forwarded scroll lowers quality, restored ~300ms after release', async () => {
  noteRtt(800); // linkLatency 800ms — above the slow-link gate
  const { rfb } = await freshViewer(createMockRfb);
  await settled();
  const screen = makeScreen();
  assert.equal(rfb.qualityLevel, 9, 'starts at configured quality');
  scroll(screen, 400, 250);
  assert.equal(rfb.qualityLevel, 6, 'lowered while the forwarded scroll is in flight');
  release(screen, 250);
  await sleep(120);
  assert.equal(rfb.qualityLevel, 6, 'still low within the settle debounce (fling tail)');
  await sleep(300);
  assert.equal(rfb.qualityLevel, 9, 'restored to configured quality after motion settles');
});

// ?motionq=1 is exercised in its own file (motion-quality-forced.test.mjs): env.js
// freezes flags at first import, so a search-string variant needs a fresh process.
