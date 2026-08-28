// nav-stale-rects.test.mjs — after a navigation the rects we still hold describe the
// document that is gone, so a tap matching none of them is not a confirmed non-input
// and must not dismiss a live keyboard. Own file: fit's pid state is module-level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, pushSignal, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const USER = { x: 100, y: 200, w: 200, h: 40 };
const PASS = { x: 100, y: 260, w: 200, h: 40 };

function tapAt(screen, x, y) {
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
}
const raised = (proxy) => globalThis.document.activeElement === proxy && proxy.style.left !== '-9999px';

test('a miss against a dead layout does not dismiss the keyboard', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: true, focusKey: 'user', rect: USER, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [USER, PASS], pid: 'p1' });
  tapAt(screen, 200, 210); // on the username field: keyboard up
  assert.ok(raised(proxy));
  // The reload is reported before the new document's rects arrive.
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [], pid: 'p2' });
  tapAt(screen, 200, 319); // where the field now is, outside every rect we hold
  assert.ok(raised(proxy), 'the stale rects cannot prove this was a non-input tap');
});
