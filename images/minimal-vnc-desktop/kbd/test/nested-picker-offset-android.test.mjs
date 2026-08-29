// nested-picker-offset-android.test.mjs — the same depth-3 DOB picker, Android.
//
// Two things differ from the iOS half (nested-picker-offset.test.mjs):
//
//   * the viewer here is itself embedded in an Android WebView, so it is not the
//     top window. Nothing about the picker overlay may depend on that — the
//     overlay is gated on `isTouch && MAGNIFY`, never on the platform, and a
//     regression that made it iOS-only would leave Android tapping the streamed
//     Chromium calendar it cannot drive;
//   * an adjustResize WebView shrinks the LAYOUT viewport for the soft keyboard
//     (839 -> 527 measured on the emulator, see docs/WEBVIEW_EMBED.md). The
//     overlays are clamped to window.innerHeight, so a keyboard raised by the
//     text field above the DOB row moves the page's lower controls behind it.
//     A hit target left live back there is invisible and untappable, and a tap
//     that lands on it opens the wrong control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, makeScreen, fireWindow } from './stub-dom.mjs';
import { loadOffsetState, CHAIN, nestedState } from './content-offset.mjs';

installGlobals('android-input', { embedded: true, search: '?magnify=1' });
const { createNativePickerProxy } = await import('../native-picker.js');

const offsetState = loadOffsetState();

const H_REST = 844, H_KBD = 527;

// The DOB row from nestedState() plus a second temporal control further down the
// form — the one the keyboard swallows.
function dobForm() {
  const state = nestedState();
  state.pickers.push({
    k: 'dob:2', t: 'month', r: { x: 24, y: 364, w: 342, h: 56 },
    v: '1994-03', a: 'Card expiry',
  });
  return offsetState(state, CHAIN.x, CHAIN.y);
}

function newProxy() {
  makeScreen();
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: () => true,
  });
  proxy.setTransportReady(true);
  return proxy;
}

function setLayoutHeight(h) {
  globalThis.window.innerHeight = h;
  fireWindow('resize');
}

test('an embedded Android viewer places a depth-3 DOB picker like any other', () => {
  setLayoutHeight(H_REST);
  const proxy = newProxy();
  proxy.applySignal(dobForm());

  const entry = proxy._entries().get('dob:1');
  assert.ok(entry, 'the overlay is not gated on iOS');
  assert.equal(entry.el.type, 'date');
  assert.equal(entry.el.style.display, 'block');
  assert.equal(entry.el.style.left, '40.00px');
  assert.equal(entry.el.style.top, '456.00px');
  assert.equal(entry.el.getAttribute('max'), '2008-12-31', 'the age bound survives the frame chain');
});

test('the local input owns the tap, so Android opens its own date dialog', () => {
  setLayoutHeight(H_REST);
  const proxy = newProxy();
  proxy.applySignal(dobForm());
  const el = proxy._entries().get('dob:1').el;
  // A tap inside the mapped box has to reach a real local <input type="date">;
  // the streamed remote calendar is not a drivable surface.
  assert.ok(proxy.owns(el), 'taps on the box belong to the local picker');
  assert.match(el.style.cssText, /pointer-events:auto/);
  assert.match(el.style.cssText, /color:transparent/);
});

test('a WebView keyboard shrinking the layout viewport retires the controls it covers', () => {
  setLayoutHeight(H_REST);
  const proxy = newProxy();
  proxy.applySignal(dobForm());
  const dob = proxy._entries().get('dob:1').el;
  const expiry = proxy._entries().get('dob:2').el;
  assert.equal(expiry.style.display, 'block');

  setLayoutHeight(H_KBD); // adjustResize: 839 -> 527, the whole page reflows
  assert.equal(dob.style.display, 'block', 'a row still on screen keeps its picker');
  assert.equal(expiry.style.display, 'none',
    'a row now behind the keyboard leaves no invisible hit target');

  setLayoutHeight(H_REST); // keyboard dismissed
  assert.equal(expiry.style.display, 'block', 'and it comes back when the row does');
});

test('a lost socket clears every nested picker, not just the focused one', () => {
  setLayoutHeight(H_REST);
  const proxy = newProxy();
  proxy.applySignal(dobForm());
  proxy.setTransportReady(false);
  for (const key of ['dob:1', 'dob:2']) {
    assert.equal(proxy._entries().get(key).el.style.display, 'none', key + ' retired');
  }
});
