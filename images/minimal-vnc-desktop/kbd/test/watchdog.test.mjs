// watchdog.test.mjs — characterization: the stuck-keyboard watchdog. If a
// dismiss signal is lost, keyboardActive wedges "up"; two consecutive 1s ticks
// with the proxy unfocused force a clean dismiss. Intervals never self-tick in
// the stub — tickIntervals() drives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, pushSignal, fireDoc, makeScreen, tickIntervals,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios');

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

async function raisedViewer() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 220 }], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 220 }], target: canvas });
  pushSignal({ editable: true, focusKey: 'w1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.equal(globalThis.document.activeElement, v.proxy, 'raised');
  return v;
}

function proxyParked(proxy) { return proxy.style.left === '-9999px'; }

test('proxy focus lost for two ticks -> forced clean dismiss', async () => {
  const { proxy } = await raisedViewer();
  globalThis.document.activeElement = null; // OS keyboard really gone; dismiss signal lost
  tickIntervals(); // miss 1
  assert.ok(!proxyParked(proxy), 'one miss is tolerated');
  tickIntervals(); // miss 2 -> dismiss
  assert.ok(proxyParked(proxy), 'watchdog forced the dismiss');
});

test('proxy still focused -> watchdog never fires', async () => {
  const { proxy } = await raisedViewer();
  tickIntervals();
  tickIntervals();
  tickIntervals();
  assert.equal(globalThis.document.activeElement, proxy, 'healthy keyboard untouched');
  assert.ok(!proxyParked(proxy));
});

test('a single transient focus loss recovers without dismissing', async () => {
  const { proxy } = await raisedViewer();
  globalThis.document.activeElement = null;
  tickIntervals(); // miss 1
  proxy.focus();   // focus came back (e.g. the paste-button round trip)
  tickIntervals(); // miss counter resets
  globalThis.document.activeElement = null;
  tickIntervals(); // miss 1 again — still under the threshold
  proxy.focus();
  tickIntervals();
  assert.ok(!proxyParked(proxy), 'no dismiss across transient blips');
});
