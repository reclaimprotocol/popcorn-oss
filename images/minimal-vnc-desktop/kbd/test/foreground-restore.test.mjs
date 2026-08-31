// foreground-restore.test.mjs — coming back from another app (a password manager, the camera)
// must return the keyboard to the field the remote still holds focused. Requiring a fresh tap
// reads as "the field won't take input": the measured end state was editable=true, kbd=false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, makeScreen, pushSignal, fireDoc } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const FIELD = { x: 40, y: 254, w: 317, h: 34 };
const raised = (proxy) => globalThis.document.activeElement === proxy && proxy.style.left !== '-9999px';
function setHidden(hidden) {
  globalThis.document.hidden = hidden;
  fireDoc('visibilitychange', {});
}

test('the keyboard returns to a field the remote still has focused', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  pushSignal({ editable: false, vw: 412, vh: 839, rects: [FIELD] });
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 271 }], changedTouches: [{ clientX: 200, clientY: 271 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 271 }], target: canvas });
  pushSignal({ editable: true, focusKey: 'pw', rect: FIELD, hints: {}, sync: {}, vw: 412, vh: 839, rects: [FIELD] });
  assert.ok(raised(proxy), 'tapping the field raised the keyboard');

  // Away to another app: the OS dismisses the keyboard, the remote keeps the field focused.
  setHidden(true);
  proxy.blur();
  assert.ok(!raised(proxy));

  setHidden(false);
  await sleep(400); // the reconcile is deferred so the viewport has settled
  assert.ok(raised(proxy), 'and back on the field the user left');
});

test('a keyboard the user dismissed before leaving stays down', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  pushSignal({ editable: false, vw: 412, vh: 839, rects: [FIELD] });
  fireDoc('touchstart', { touches: [{ clientX: 200, clientY: 271 }], changedTouches: [{ clientX: 200, clientY: 271 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 271 }], target: canvas });
  pushSignal({ editable: true, focusKey: 'pw2', rect: FIELD, hints: {}, sync: {}, vw: 412, vh: 839, rects: [FIELD] });
  assert.ok(raised(proxy));
  // The remote drops the focus (the user submitted, or tapped elsewhere) before we go away.
  pushSignal({ editable: false, vw: 412, vh: 839, rects: [FIELD] });
  await sleep(500);

  setHidden(true);
  proxy.blur();
  setHidden(false);
  await sleep(400);
  assert.ok(!raised(proxy), 'no field waiting for input -> no surprise keyboard');
});
