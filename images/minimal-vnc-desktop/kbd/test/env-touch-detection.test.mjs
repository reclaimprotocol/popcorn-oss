// env-touch-detection.test.mjs — which devices count as touch-primary.
//
// env.js decides this once, at module load, and everything hangs off it: DESKTOP,
// the tap layer, the keyboard raise, the magnify button. Measured in an Android
// WebView on an emulator, tapping a remote field did nothing at all and the trace
// said why:
//   setup env: android=1 touch=0 desktop=1 ...
//   SIG editable=true ... kbd=false dtap=- tap#-
// The WebView reported maxTouchPoints 5 and hover:none, but pointer:coarse FALSE
// and pointer:fine TRUE — the host mouse drives the emulator's input — so both
// original clauses failed. A WebView on a real device with a mouse attached, or a
// desktop-mode phone, presents the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// env.js reads window/navigator at module scope, so each case needs its own
// module instance: a cache-busting query gives one.
async function isTouchFor({ queries, maxTouchPoints, ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/113 Mobile' }, tag) {
  globalThis.window = globalThis;
  // navigator is getter-only on globalThis in modern Node — same approach as stub-dom.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, maxTouchPoints }, configurable: true, writable: true,
  });
  globalThis.location = { search: '', pathname: '/vnc/liveview.html' };
  globalThis.window.matchMedia = (q) => ({ matches: Boolean(queries[q]) });
  const mod = await import(`../env.js?case=${tag}`);
  return mod.isTouch;
}

test('a phone is touch-primary (pointer: coarse)', async () => {
  assert.equal(await isTouchFor({
    queries: { '(pointer: coarse)': true, '(hover: none)': true },
    maxTouchPoints: 5,
  }, 'phone'), true);
});

test('the WebView that reported a FINE pointer is still touch-primary', async () => {
  // The measured emulator numbers, exactly.
  assert.equal(await isTouchFor({
    queries: { '(pointer: coarse)': false, '(pointer: fine)': true, '(hover: none)': true },
    maxTouchPoints: 5,
  }, 'webview-fine'), true);
});

test('a desktop mouse is not touch-primary', async () => {
  assert.equal(await isTouchFor({
    queries: { '(pointer: fine)': true, '(hover: hover)': true, '(hover: none)': false },
    maxTouchPoints: 0,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36',
  }, 'desktop'), false);
});

test('a touch LAPTOP stays on the desktop path — it can hover', async () => {
  // The regression the second clause was written to avoid: a touchscreen laptop
  // has touch points, but its primary pointer is the trackpad.
  assert.equal(await isTouchFor({
    queries: { '(pointer: coarse)': false, '(pointer: fine)': true, '(hover: hover)': true, '(hover: none)': false },
    maxTouchPoints: 10,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
  }, 'touch-laptop'), false);
});

test('a device with no matchMedia at all is not guessed into touch', async () => {
  globalThis.window = globalThis;
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', maxTouchPoints: 0 },
    configurable: true, writable: true,
  });
  globalThis.location = { search: '', pathname: '/vnc/liveview.html' };
  delete globalThis.window.matchMedia;
  const mod = await import('../env.js?case=no-mm');
  assert.equal(mod.isTouch, false);
});
