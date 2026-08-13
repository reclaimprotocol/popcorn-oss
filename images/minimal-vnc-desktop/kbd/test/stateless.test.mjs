// stateless.test.mjs — characterization: ?stateless=1 (desktop-style keyboard).
// /kbd is ADVISORY only: it never dismisses and never re-raises. Raise is
// optimistic and local; dismiss comes only from real local events. Degrades
// like a desktop VNC client — laggy, never wedged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  installGlobals, freshViewer, pushSignal, fireDoc, makeScreen,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { search: '?stateless=1' });

const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

async function fieldViewer() {
  const v = await freshViewer(createMockRfb);
  const screen = makeScreen();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  return { ...v, screen };
}
function tapAt(screen, x, y) {
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
}

test('tap-hit raises with NO armDismiss — keyboard survives with no remote confirm', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  assert.equal(globalThis.document.activeElement, proxy);
  await sleep(1700); // would be past the RTT-adaptive teardown in stateful mode
  assert.equal(globalThis.document.activeElement, proxy, 'no confirm needed — stays up');
});

test('a stale editable:false NEVER dismisses the keyboard', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  pushSignal({ editable: false, rects: [FIELD_RECT], vw: 390, vh: 844 });
  await sleep(500); // past the stateful 350ms grace
  assert.equal(globalThis.document.activeElement, proxy, '/kbd is advisory — no flap-driven thrash');
});

test('a miss-tap does not dismiss either — dismiss stays a deliberate act', async () => {
  const { proxy, screen } = await fieldViewer();
  tapAt(screen, 200, 220);
  await sleep(200);
  tapAt(screen, 30, 700); // confirmed non-input tap
  assert.equal(globalThis.document.activeElement, proxy, 'rects are stale-derived; never dismiss on them');
});

test('editable:true for a new field does not re-raise (advisory only)', async () => {
  const { proxy, screen } = await fieldViewer();
  // No tap at all — an ambient focus flap on the remote.
  pushSignal({ editable: true, focusKey: 'ambient', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  assert.notEqual(globalThis.document.activeElement, proxy, 'no signal-driven raise in stateless mode');
});
