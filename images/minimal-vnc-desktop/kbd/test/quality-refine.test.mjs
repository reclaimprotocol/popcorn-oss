// quality-refine.test.mjs — characterization: connection quality handling.
//
// The configured JPEG quality is high because text is the payload. These tests pin
// the connection behavior and its interaction with adaptive lowering, ensuring a
// slow-link motion hold does not prevent restoration to the sharp target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';
import { noteRtt } from '../latency.js';

installGlobals('ios', { search: '?magnify=1' });

// quality.js logs through diag.js (which reads `window` at init), so import it
// after installGlobals.
const { COLD_QUALITY, REFINE_IDLE_MS } = await import('../quality.js');

// The mock RFB is configured at quality 9 — the sharp target used in production.
const SHARP = 9;

function scroll(screen, fromY, toY) {
  fireDoc('touchstart', { touches: [{ clientX: 100, clientY: fromY }], changedTouches: [{ clientX: 100, clientY: fromY }], target: screen });
  fireDoc('touchmove', { touches: [{ clientX: 100, clientY: toY }], changedTouches: [{ clientX: 100, clientY: toY }], target: screen });
}
function release(screen, y) {
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 100, clientY: y }], target: screen });
}

// Runs FIRST, while linkLatency is still 0 (fast link) so the adaptive path stays out.
test('connect starts at the configured sharp quality', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  assert.equal(rfb.qualityLevel, COLD_QUALITY, 'first paint stays sharp');
  await sleep(REFINE_IDLE_MS + 80);
  assert.equal(rfb.qualityLevel, SHARP, 'stepped up once the stream settled');
});

test('a reconnect repeats the cycle rather than staying sharp', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  await sleep(REFINE_IDLE_MS + 80);
  assert.equal(rfb.qualityLevel, SHARP);
  // Soft detach + reconnect is the 3G blip path: the new RFB arrives at its
  // configured quality, and the first paint of the NEW connection should be cheap
  // again (it is a full-screen repaint).
  rfb.qualityLevel = SHARP;
  rfb.fireConnect();
  assert.equal(rfb.qualityLevel, COLD_QUALITY, 'reconnect paints cold again');
  await sleep(REFINE_IDLE_MS + 80);
  assert.equal(rfb.qualityLevel, SHARP, 'and re-refines');
});

test('slow link: refinement completing mid-scroll is not lost on settle', async () => {
  noteRtt(800); // above the slow-link gate, so motion lowers quality
  const { rfb } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  assert.equal(rfb.qualityLevel, COLD_QUALITY, 'cold at first paint');

  // Keep dragging across the refine boundary. One touchmove is not enough: the
  // motion hold self-releases MOTION_RESTORE_MS after the LAST move, so a single
  // move would have settled long before the refine timer fired.
  scroll(screen, 400, 380);
  const lowered = rfb.qualityLevel;
  assert.ok(lowered < COLD_QUALITY, `motion floor engaged (${lowered})`);
  let y = 380;
  for (let i = 0; i < 8; i++) {          // ~800ms of continuous dragging
    await sleep(100);
    y -= 10;
    fireDoc('touchmove', { touches: [{ clientX: 100, clientY: y }], changedTouches: [{ clientX: 100, clientY: y }], target: screen });
  }
  assert.equal(rfb.qualityLevel, lowered, 'refinement does not fight the motion hold');

  // On settle it must land on the SHARP target, not back on the cold value.
  release(screen, y);
  await sleep(420);
  assert.equal(rfb.qualityLevel, SHARP, 'settles at the refined quality');
});
