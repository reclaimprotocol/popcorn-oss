// fbscale.test.mjs — the supersampled framebuffer policy (kbd/fbscale.js).
//
// What this is for: on a phone the framebuffer is sized in CSS pixels, so a 411px
// viewport streams 411 remote pixels onto ~1080 device pixels — 0.38 remote px per
// device px, and no encoder setting can put the missing detail back. Raising CDP
// deviceScaleFactor and growing the framebuffer with it fixes that at a cost of k^2
// pixels per frame.
//
// So the policy is the part worth testing, because the cost lands on the pod and on
// the wire: 4x encode area on a CPU-throttled browser pod turns into frame latency,
// which is the OTHER half of this bug report ("the text appears only after a
// delay"). Sharpness bought with paint latency is not a win, and these tests are
// what keep the decision conservative.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.location = { search: '?magnify=1', pathname: '/vnc/liveview.html' };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', maxTouchPoints: 5, connection: null },
  configurable: true, writable: true,
});
globalThis.matchMedia = () => ({ matches: true }); // pointer: coarse
globalThis.devicePixelRatio = 2.625;              // a Pixel-class phone
globalThis.fetch = () => Promise.resolve({ ok: true });

const { wantedScale, FBSCALE_MODE } = await import('../fbscale.js');
const { noteRtt } = await import('../latency.js');

// The RTT EMA is process-wide (see test/README.md), so these run in order and the
// link is driven from "unknown" upward.
test('default mode is 1x until supersampling is explicitly enabled', () => {
  assert.equal(FBSCALE_MODE, 1);
});

test('an UNMEASURED link stays at 1x — cold start costs what it costs today', () => {
  // The most important case: at connect the RTT EMA is 0. Unknown is not healthy,
  // and a first paint at 4x the bytes on a link that turns out to be 3G is exactly
  // the regression this feature must not ship.
  assert.equal(wantedScale(), 1);
});

test('a measured healthy link stays 1x unless auto mode is explicitly requested', () => {
  noteRtt(120);
  assert.equal(wantedScale(), 1);
});

test('a slow link stays at 1x', () => {
  // Push the EMA past the 400ms gate. Same threshold quality.js uses to START
  // shedding JPEG quality, so the two levers can never fight — we stop adding
  // pixels before it starts removing them.
  for (let i = 0; i < 12; i++) noteRtt(1500);
  assert.equal(wantedScale(), 1);
});

test('link recovery does not silently enable supersampling', () => {
  for (let i = 0; i < 12; i++) noteRtt(90);
  assert.equal(wantedScale(), 1);
});

test('saveData and 2g/3g veto it outright', () => {
  const c = globalThis.navigator.connection;
  globalThis.navigator.connection = { saveData: true };
  assert.equal(wantedScale(), 1, 'saveData means the user asked us not to');
  globalThis.navigator.connection = { effectiveType: '3g' };
  assert.equal(wantedScale(), 1, '3g cannot afford 4x the bytes');
  globalThis.navigator.connection = { effectiveType: '4g' };
  assert.equal(wantedScale(), 1);
  globalThis.navigator.connection = c;
});

test('a 1x display gains nothing, so it is not charged for it', () => {
  globalThis.devicePixelRatio = 1;
  assert.equal(wantedScale(), 1);
  globalThis.devicePixelRatio = 2.625;
});

test('a desktop-fit page is already supersampled — no doubling', () => {
  // 980 remote px into a 411px viewport is ~0.91 remote px per device px, which is
  // why desktop-fallback pages look sharp while responsive ones look soft. Fit also
  // owns the framebuffer and #screen, so a second mechanism there would fight it.
  globalThis.window.__pcnFitActive = true;
  assert.equal(wantedScale(), 1);
  globalThis.window.__pcnFitActive = false;
  assert.equal(wantedScale(), 1);
});
