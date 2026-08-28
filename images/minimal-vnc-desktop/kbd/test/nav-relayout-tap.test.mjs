// nav-relayout-tap.test.mjs — a tap verdict must not outlive the layout it judged.
//
// Reported on a university login page: a failed login reloaded it with an
// "Invalid login, please try again" banner that pushed both fields down ~39px. The next tap was hit-tested against the pre-reload rects, landed in the gap,
// and was recorded as a CONFIRMED miss — which dismissed the keyboard and then blocked
// the recovery raise ("recovery raise SUPPRESSED"), so the field the remote had just
// focused could not be typed into until the user tapped it a second time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, pushSignal, fireDoc, makeScreen } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const USER = { x: 100, y: 200, w: 200, h: 40 };
const PASS = { x: 100, y: 260, w: 200, h: 40 };
const SHIFT = 39; // the banner's height, as measured in the session
const shifted = (r) => ({ ...r, y: r.y + SHIFT });

async function viewer() {
  const v = await freshViewer(createMockRfb);
  return { ...v, screen: makeScreen() };
}
function tapAt(screen, x, y) {
  const canvas = screen.querySelector('canvas');
  fireDoc('touchstart', { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: x, clientY: y }], target: canvas });
}
const raised = (proxy) => globalThis.document.activeElement === proxy && proxy.style.left !== '-9999px';

test('a miss judged on the pre-reload layout does not block the recovery raise', async () => {
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [USER, PASS], pid: 'p1' });
  // The reload has happened remotely but its first report has not arrived yet, so the
  // tap on the moved password field is judged against the old rects and lands in a gap.
  tapAt(screen, 200, 319);
  assert.ok(!raised(proxy), 'nothing local can raise here — the rects say non-input');
  // Now the new document reports: same fields, 39px lower, and the remote confirms it
  // focused the password field in response to that tap.
  pushSignal({ editable: true, focusKey: 'pw', rect: shifted(PASS), hints: {}, sync: {},
    vw: 390, vh: 844, rects: [shifted(USER), shifted(PASS)], pid: 'p2' });
  assert.ok(raised(proxy), 'the stale miss must not suppress the authoritative recovery');
});

test('a miss on the CURRENT layout still suppresses an ambient focus flap', async () => {
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [USER, PASS], pid: 'q1' });
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [USER, PASS], pid: 'q1' }); // settled cadence
  tapAt(screen, 20, 700); // nowhere near a field
  // Same geometry re-reported (the 250ms cadence) plus an unrelated remote focus.
  pushSignal({ editable: true, focusKey: 'pw', rect: PASS, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [USER, PASS], pid: 'q1' });
  assert.ok(!raised(proxy), 'a live miss verdict still holds across identical reports');
});
