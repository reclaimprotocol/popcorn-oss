// fbscale-pinned.test.mjs — a PINNED ?fbscale=N must actually reach the framebuffer.
//
// One platform profile per file (see README): this one is a Pixel-class phone with
// ?fbscale=2, which the other fbscale file cannot express — FBSCALE_MODE is frozen
// from location.search at first import.
//
// REGRESSION (reproduced in Chrome on an emulated Pixel 7 against a real pod):
// `?fbscale=2` did nothing at all. The framebuffer stayed 412x915, the scale line
// kept reporting fbscale=1, and no 'fbscale' line was ever logged. The cause is
// the boot ORDER: kbd-autofocus starts the watcher inside setup(), which runs
// ~8ms before the RFB connection is ready, and the watcher's getBlocked() is
// `... || !rfbReady`. In auto mode that costs nothing — the 2s poll tries again.
// In pinned mode start() evaluated ONCE and never armed a timer, so the single
// evaluation landed in the blocked window and the factor was dropped for the rest
// of the session.
//
// Why that matters more than it looks: ?fbscale=N is the A/B lever for the
// "blurry on Android" report. A lever that silently does nothing does not just
// fail to help, it produces a WRONG measurement — an integrator compares
// fbscale=1 against fbscale=2, sees identical pixels, and concludes supersampling
// is not the problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.location = { search: '?magnify=1&fbscale=2', pathname: '/vnc/liveview.html' };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', maxTouchPoints: 5, connection: null },
  configurable: true, writable: true,
});
globalThis.matchMedia = () => ({ matches: true });
globalThis.devicePixelRatio = 2.625;
globalThis.fetch = () => Promise.resolve({ ok: true });

const { FBSCALE_MODE, wantedScale, createFbScaleWatch } = await import('../fbscale.js');

test('a pinned factor is read from the URL and ignores link health', () => {
  assert.equal(FBSCALE_MODE, 2);
  assert.equal(wantedScale(), 2, 'pinned means pinned — no RTT sample needed');
});

test('a pinned factor blocked at start() is still applied once the block clears', async () => {
  let current = 1;
  let blocked = true;              // exactly the boot state: rfb not ready yet
  const applied = [];
  const watch = createFbScaleWatch({
    getCurrent: () => current,
    getBlocked: () => blocked,
    onChange: (k) => { applied.push(k); current = k; },
  });
  watch.start();
  assert.deepEqual(applied, [], 'nothing applied while blocked (that part was right)');

  blocked = false;                 // rfb connects a few ms later
  await new Promise((r) => setTimeout(r, 2600));   // one watch tick (WATCH_MS = 2000)
  watch.stop();
  assert.deepEqual(applied, [2], 'the pinned factor lands as soon as it can');
});

test('a pinned factor stops costing anything once it has landed', async () => {
  let current = 1;
  const applied = [];
  const watch = createFbScaleWatch({
    getCurrent: () => current,
    getBlocked: () => false,
    onChange: (k) => { applied.push(k); current = k; },
  });
  watch.start();
  await new Promise((r) => setTimeout(r, 2600));
  watch.stop();
  assert.deepEqual(applied, [2], 'applied once, not re-applied on every tick');
});
