// host-sdk-layout-keyboard.test.mjs — the HOST side (host/popcorn-host.js) in the
// adjustResize WebView cell, driven in a stub window so it runs under
// `node --test kbd/test/*.test.mjs` with everything else.
//
// Measured on an emulator, real three-level embed chain (SDK -> relay -> viewer)
// inside the Android WebView shell, tapping a password field at depth 3:
//
//   before: HOST_GEOMETRY visibleHeight=527 occludedBottom=0  rawInner=527 rawVv=527
//   after:  HOST_GEOMETRY visibleHeight=527 occludedBottom=312 rawInner=527 rawVv=527
//
// The WebView shrinks the LAYOUT viewport for the keyboard, so innerHeight and
// visualViewport.height move together and measure()'s `|innerH - vv.height| < 50`
// branch used to relearn the baseline DOWN to the shrunken height and report no
// keyboard — for the whole session. The viewer was then left with no
// authoritative rect anywhere, in the one cell where its own detectors are
// weakest.
//
// The inference is gated on the viewer's POPCORN_KBD_STATE raise, because a
// split-screen drag looks identical to the width guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../host/popcorn-host.js'),
  'utf8',
);

const REST_H = 839, KBD_H = 527, WIDTH = 384; // the emulator's own numbers

function stubWindow() {
  const listeners = {};
  const posted = [];
  const win = {
    innerWidth: WIDTH,
    innerHeight: REST_H,
    visualViewport: { height: REST_H, offsetTop: 0, addEventListener() {} },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/113 Mobile' },
    location: { origin: 'https://host.test', search: '', href: 'https://host.test/' },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    getComputedStyle: () => ({ position: 'static' }),
    parent: null,
    console: { log() {}, warn() {}, error() {} },
  };
  win.window = win;
  win.top = win; // top-level => PopcornHost resolves to MEASURE
  win.document = {
    documentElement: { clientHeight: REST_H, clientWidth: WIDTH },
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible',
  };
  // The child frame we post geometry into.
  const iframe = {
    tagName: 'IFRAME',
    style: {},
    getBoundingClientRect: () => ({ width: WIDTH, height: REST_H, top: 0, left: 0 }),
    contentWindow: { postMessage: (msg) => posted.push(msg) },
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
    parentNode: null, ownerDocument: win.document,
  };
  const api = new Function('window', 'self', `${SDK}; return window.PopcornHost;`)(win, win);
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
  return { win, iframe, posted, api, fire };
}

function lastGeometry(posted) {
  for (let i = posted.length - 1; i >= 0; i--) {
    if (posted[i] && posted[i].type === 'POPCORN_HOST_GEOMETRY') return posted[i];
  }
  return null;
}

// Drive the same sequence the device did: attach, viewer raises, layout shrinks.
function raiseAndShrink({ raise }) {
  const h = stubWindow();
  const host = h.api.attach(h.iframe, { childOrigin: '*' });
  if (raise) {
    // The viewer's own message, arriving from the frame below.
    h.fire('message', {
      source: h.iframe.contentWindow,
      origin: 'https://viewer.test',
      data: { type: 'POPCORN_KBD_STATE', protocol: h.api.PROTOCOL, active: true, reason: 'tap-hit' },
    });
  }
  h.posted.length = 0;
  h.win.innerHeight = KBD_H;              // adjustResize: BOTH shrink together
  h.win.visualViewport.height = KBD_H;
  h.fire('resize', {});
  return { h, host };
}

test('a layout-viewport keyboard is reported as a real occlusion, not as no keyboard', () => {
  const { h } = raiseAndShrink({ raise: true });
  const g = lastGeometry(h.posted);
  assert.ok(g, 'geometry was posted to the frame below');
  assert.equal(Math.round(g.visibleHeight), KBD_H, 'visible height is what the keyboard left');
  assert.equal(Math.round(g.occludedBottom), REST_H - KBD_H, 'and the keyboard height is reported');
});

test('without the viewer raise the same shrink is a relayout, not a keyboard', () => {
  // Split-screen drag / foldable posture change: identical numbers, no keyboard.
  const { h } = raiseAndShrink({ raise: false });
  const g = lastGeometry(h.posted);
  assert.ok(g, 'geometry still posted');
  assert.equal(Math.round(g.occludedBottom), 0, 'no phantom keyboard for the viewer to lift for');
});

test('a browser that shrinks only the VISUAL viewport is unaffected', () => {
  // Chrome on Android: innerHeight stays, visualViewport shrinks. Measured 783/471.
  const h = stubWindow();
  h.api.attach(h.iframe, { childOrigin: '*' });
  // Learn the baseline at THIS browser's resting height first, the way a real
  // session does — the occlusion is measured against the baseline, so starting
  // from another device's numbers would just be testing the arithmetic wrong.
  h.win.innerHeight = 783;
  h.win.visualViewport.height = 783;
  h.fire('resize', {});
  h.posted.length = 0;
  h.win.visualViewport.height = 471;   // only the VISUAL viewport moves
  h.win.visualViewport.offsetTop = 312;
  h.fire('resize', {});
  const g = lastGeometry(h.posted);
  assert.ok(g);
  assert.equal(Math.round(g.occludedBottom), 783 - 471, 'the pre-existing visual-viewport path still measures');
});

test('a small height-only change is still ordinary chrome geometry', () => {
  const h = stubWindow();
  h.api.attach(h.iframe, { childOrigin: '*' });
  h.fire('message', {
    source: h.iframe.contentWindow,
    origin: 'https://viewer.test',
    data: { type: 'POPCORN_KBD_STATE', protocol: h.api.PROTOCOL, active: true },
  });
  h.posted.length = 0;
  h.win.innerHeight = REST_H - 60;        // a URL bar collapsing
  h.win.visualViewport.height = REST_H - 60;
  h.fire('resize', {});
  const g = lastGeometry(h.posted);
  assert.ok(g);
  assert.equal(Math.round(g.occludedBottom), 0, 'below a keyboard height: reported as no keyboard');
});
