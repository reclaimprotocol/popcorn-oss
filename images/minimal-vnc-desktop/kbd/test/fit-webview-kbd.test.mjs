// fit-webview-kbd.test.mjs — regression: in an Android WebView the soft keyboard
// resizes the LAYOUT viewport (adjustResize), so a keyboard open is the only
// thing that fires a window 'resize' — the very event fit uses to re-request the
// remote desktop size.
//
// Measured on an emulator (Pixel 7, API 34, WebView 113), keyboard open:
//   Chrome:  innerHeight 783 -> 783, visualViewport 783 -> 471   (visual only)
//   WebView: innerHeight 839 -> 527, visualViewport 839 -> 527   (layout too)
//
// fit's guard read getKeyboardActive() at EVENT time, which is only true if
// kbd-detect's own 'resize' listener already ran and latched. Both listeners are
// on window, so the order decides it — and on the first open the detector needs
// the proxy focused AND a >150px shrink before it latches at all. Lose that race
// and fit POSTs a new /emulate mid-typing: the remote desktop resizes, the page
// under it reflows, the focused field is re-created and the keyboard closes.
// Reported as "when I try to enter the password it keeps closing the keyboard".
//
// Observable: the /emulate POSTs fit issues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, fireWindow } from './stub-dom.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const { createFit } = await import('../fit.js');

const W = 390, H_OPEN = 844, H_KBD = 527; // the emulator's own numbers, scaled to the stub

const emulates = [];
globalThis.fetch = (_url, init) => {
  try { emulates.push(JSON.parse(init.body)); } catch (_) {}
  return Promise.resolve({ ok: true });
};

function makeFit() {
  let keyboardActive = false;
  const screen = { style: {}, offsetWidth: W, offsetHeight: H_OPEN, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const fit = createFit({
    getRfb: () => rfb,
    getScreenElement: () => screen,
    getKeyboardActive: () => keyboardActive,
    vt: {
      resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, zoomScale: () => 1,
      composeScreenTransform() {}, setFillFloor() {},
    },
    setMagEligible: () => {},
    updateControlButtons: () => {},
    onNavChanged: () => {},
  });
  return { fit, screen, setKeyboardActive: (v) => { keyboardActive = v; } };
}

function setViewport(w, h) { window.innerWidth = w; window.innerHeight = h; }

test('a WebView keyboard open must not re-request the remote size, even when the detector latches after fit sees the resize', async () => {
  setViewport(W, H_OPEN);
  const { fit, screen, setKeyboardActive } = makeFit();
  fit.startMagnify();
  await sleep(120);
  emulates.length = 0; // the connect-time emulate is expected; watch what follows

  // The keyboard opens: layout viewport shrinks, width untouched.
  setViewport(W, H_KBD);
  screen.offsetHeight = H_KBD;
  fireWindow('resize');
  // kbd-detect's listener runs after fit's on this device, so the latch lands
  // just after the event fit already handled.
  setKeyboardActive(true);

  await sleep(500); // past fit's 350ms push debounce

  assert.deepEqual(emulates, [],
    `no remote resize while the keyboard is up, got ${JSON.stringify(emulates)}`);
});

test('a real width change still re-requests the remote size', async () => {
  setViewport(W, H_OPEN);
  const { fit, screen } = makeFit();
  fit.startMagnify();
  await sleep(120);
  emulates.length = 0;

  setViewport(H_OPEN, W); // rotate: width really changed
  screen.offsetWidth = H_OPEN; screen.offsetHeight = W;
  fireWindow('resize');
  await sleep(500);

  assert.ok(emulates.length > 0, 'a genuine resize still reaches the remote');
  assert.equal(emulates.at(-1).width, H_OPEN);
});

test('the keyboard-shrunk height never defines the remote viewport, whoever asks', async () => {
  setViewport(W, H_OPEN);
  const { fit, screen, setKeyboardActive } = makeFit();
  fit.startMagnify();
  await sleep(120);
  emulates.length = 0;

  // The keyboard is up, and something other than the resize path asks for an
  // emulate: a connect-time settle retry, the geometry watcher, fbscale.
  setKeyboardActive(true);
  setViewport(W, H_KBD);
  screen.offsetHeight = H_KBD;
  fit.pushEmulate();
  await sleep(50);

  if (emulates.length) {
    assert.equal(emulates.at(-1).height, H_OPEN,
      'emulated at the pre-keyboard height, not the shrunken one');
  }

  // Once the keyboard is gone a genuinely shorter viewport is honoured again.
  setKeyboardActive(false);
  setViewport(W, 700);
  screen.offsetHeight = 700;
  fit.pushEmulate();
  await sleep(50);
  assert.equal(emulates.at(-1).height, 700, 'real height changes still reach the remote');
});
