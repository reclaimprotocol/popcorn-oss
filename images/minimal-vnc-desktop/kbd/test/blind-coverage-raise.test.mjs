// blind-coverage-raise.test.mjs — the first tap on a CROSS-ORIGIN form field must
// not wait for a tunnel round-trip.
//
// The reported symptom: on Android, tapping the first field of a portal-hosted
// signup form did nothing for about two seconds, then the keyboard appeared —
// long enough that people assume typing is broken and give up. The gesture itself
// was never the problem; the input log shows the touch reaching the remote browser
// in 27-58ms with nothing dropped.
//
// What actually happened is a coverage gap. The viewer raises the keyboard
// instantly when a tap lands on a rect it knows about, and otherwise waits for the
// remote's authoritative editable:true — which is a full round-trip away. The
// fields live in a cross-origin iframe, and that frame's content script cannot
// report a single coordinate until its parent has told it where it sits (see the
// __pcnKbdAbs handshake in extensions/proxy/content.js). Until then it used to
// report NOTHING, so its fields were indistinguishable from a page that has no
// fields at all: both are 'unknown' coverage, and 'unknown' deliberately does not
// pop the keyboard — otherwise every tap on a landing page of buttons would.
//
// So the frame now says the one thing it can say without coordinates: "I hold
// editable fields you cannot see." These tests pin both halves of what the viewer
// does with that — it raises on a blind tap, and it still refuses to raise when
// the page genuinely has nothing to type into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, pushSignal, fireDoc, makeScreen, advanceClock } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

// The stub canvas is 390x844 and the reported remote viewport matches it, so
// screen px and remote px are 1:1 and a tap coordinate IS the rect coordinate.
const FIELD_RECT = { x: 100, y: 200, w: 200, h: 40 };

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

test('no coverage and no explanation -> the keyboard stays down (unchanged)', async () => {
  const { proxy, screen } = await viewer();
  // A page of buttons: the extension reports a viewport and an empty rect list.
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [] });
  tapAt(screen, 200, 220);
  assert.ok(!raised(proxy), 'an unexplained miss must never pop the keyboard');
});

test('a frame reporting blind coverage -> the tap raises immediately', async () => {
  const { proxy, screen } = await viewer();
  // The cross-origin form frame is loaded and holds fields, but is still waiting
  // to be positioned, so it can publish no rects — only the blind flag.
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [], blind: true });
  tapAt(screen, 200, 220);
  assert.ok(raised(proxy), 'keyboard up in the gesture, not a round-trip later');
});

test('the blind raise is still self-correcting — no confirm, no keyboard', async () => {
  // The safety property that makes raising on incomplete information acceptable:
  // if the tap was not a field after all (a button inside that frame), the same
  // RTT-adaptive dismiss that covers a false rect hit takes it back down.
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [], blind: true });
  tapAt(screen, 200, 220);
  assert.ok(raised(proxy));
  await sleep(1700); // past the 1500ms default dismiss window
  assert.ok(!raised(proxy), 'torn back down when no editable:true arrived');
});

test('a confirmed editable:true keeps the blind raise up', async () => {
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [], blind: true });
  tapAt(screen, 200, 220);
  // The remote focused the field; the frame is positioned by now and reports it.
  pushSignal({ editable: true, focusKey: 'x1', rect: FIELD_RECT, hints: {}, sync: {},
    vw: 390, vh: 844, rects: [FIELD_RECT] });
  await sleep(1700);
  assert.ok(raised(proxy), 'the confirm cancelled the armed dismiss');
});

test('once the frame is positioned, blind clears and a real miss is honoured again', async () => {
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [], blind: true });
  // Positioned: real rects arrive and the flag is gone. This is not sticky state —
  // the merge recomputes it from every frame on every report.
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT] });
  tapAt(screen, 20, 600); // nowhere near the field: a CONFIRMED miss
  assert.ok(!raised(proxy), 'a confirmed non-input tap does not pop the keyboard');
});

test('blind coverage does not override a confirmed miss', async () => {
  // Both signals at once: some other frame is blind, but the tap landed inside the
  // coverage we DO have and matched nothing. The hit-test's answer wins — a tap on
  // a known button must not pop the keyboard just because another frame is late.
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT], blind: true });
  tapAt(screen, 20, 600);
  assert.ok(!raised(proxy), 'the rect list we have is authoritative where it covers');
});

test('a tap on a known rect still raises while another frame is blind', async () => {
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT], blind: true });
  tapAt(screen, 200, 220);
  assert.ok(raised(proxy), 'the normal optimistic hit path is unaffected');
});

test('after a cross-origin navigation the first tap on the new page still raises', async () => {
  // The three-level flow this was reported from: liveview inside a portal frame
  // inside the customer page, and the remote navigating from the portal to a
  // cross-origin hosted form. The navigation is the worst moment for coverage —
  // the old page's rects are dropped (they describe a document that is gone) and
  // the new page's cross-origin frame has not been positioned yet — which is
  // exactly where the two-second wait was felt.
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT],
    pid: 'p1', origin: 'https://portal.test' });
  // The nav: new page id, new origin, no rects yet. The nav is what makes the
  // empty list stick immediately instead of being held as a transient flap.
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [],
    pid: 'p2', origin: 'https://form.example' });
  // The form frame loads and says what it can: fields, no coordinates.
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [], blind: true,
    pid: 'p2', origin: 'https://form.example' });
  tapAt(screen, 200, 220);
  assert.ok(raised(proxy), 'the first field on the new page raises in the gesture');
});

test('a navigation to a page with NO fields does not raise', async () => {
  // The other side of the same moment: a cross-origin destination that has nothing
  // to type into reports no blind frame, so nothing changed for it.
  const { proxy, screen } = await viewer();
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [FIELD_RECT], pid: 'p1' });
  // Past RECTS_STICKY_MS, so the empty list is accepted as real rather than held as
  // a transient flap — the old page's rects would otherwise still be hit-testable
  // (which is the stickiness working as designed, not this path).
  advanceClock(3100);
  pushSignal({ editable: false, vw: 390, vh: 844, rects: [], pid: 'p2',
    origin: 'https://done.example' });
  tapAt(screen, 200, 220);
  assert.ok(!raised(proxy), 'a fieldless destination is still left alone');
});
