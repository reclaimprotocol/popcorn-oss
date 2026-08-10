// ctrl-drag.test.mjs — characterization: the draggable floating-control group's
// geometry (controls.js).
//
// The buttons sit over the bottom corner of the remote page, which is where
// "Sign in" / "Continue" buttons live — so the user can drag the cluster out of the
// way. The clamp and the side-snap are pure functions precisely so they can be
// pinned here without a DOM: the parts that need a device (touch sequences,
// localStorage persistence) are covered by the on-device harness instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

// controls.js sits in the kbd/ graph, whose leaf (env.js) reads `window` at module
// init — so the globals have to exist before the import, exactly as in every other
// file here. The helpers under test are pure; the stub is only there to let the
// module load.
installGlobals('ios', { search: '?magnify=1' });
const { clampCtrlLift, snapCtrlSide, CTRL_BASE_BOTTOM, DRAG_SLOP,
        keyboardInset, ctrlPasteBottom } = await import('../controls.js');

test('no drag means no offset', () => {
  assert.equal(clampCtrlLift(0, 800), 0);
});

test('a lift within the viewport is kept as-is', () => {
  assert.equal(clampCtrlLift(200, 800), 200);
});

test('the group can never be dragged off the top of the viewport', () => {
  // The topmost button (paste, base 124) plus its 44px height must stay inside.
  const h = 800;
  const lift = clampCtrlLift(10_000, h);
  assert.ok(lift + CTRL_BASE_BOTTOM.paste + 44 <= h, 'topmost button stays on screen');
});

test('dragging below the base position is clamped to zero, not negative', () => {
  // Dragging down past the resting place would otherwise push the buttons under
  // the bottom edge, where they are unreachable.
  assert.equal(clampCtrlLift(-300, 800), 0);
});

test('a tiny viewport degrades to no lift rather than a negative one', () => {
  assert.equal(clampCtrlLift(50, 100), 0);
});

test('non-finite input falls back to the base position', () => {
  // Guards the localStorage restore path, where the value is whatever was stored.
  assert.equal(clampCtrlLift(NaN, 800), 0);
  assert.equal(clampCtrlLift(undefined, 800), 0);
});

test('release on the left half snaps left, right half snaps right', () => {
  assert.equal(snapCtrlSide(10, 400), 'left');
  assert.equal(snapCtrlSide(390, 400), 'right');
  assert.equal(snapCtrlSide(200, 400), 'right'); // exactly centre resolves right (the default corner)
});

// ---- paste button vs the soft keyboard ---------------------------------------
// The paste button is only shown WITH the keyboard up, so if it isn't lifted clear
// of the keys it's not merely ugly — it's untappable, which is how it read on the
// embedded path (a subframe's visualViewport doesn't shrink for the keyboard, so
// the local measurement is 0 and the button rests at the very bottom, under the
// keys). These pin the branch that fixes it.

const KBD_H = 300;
// An overlay keyboard: the layout viewport keeps its full height.
const overlayWin = { innerHeight: 844, visualViewport: { height: 844 - KBD_H, offsetTop: 0 } };
// A browser that shrinks the layout viewport instead (Samsung Internet): the
// viewport bottom already sits at the keyboard's top edge.
const shrinkWin = { innerHeight: 844 - KBD_H, visualViewport: { height: 844 - KBD_H, offsetTop: 0 } };
// Embedded: our own visualViewport is blind to the keyboard.
const embeddedWin = { innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } };

test('host geometry wins over the local measurement when both are present', () => {
  // The host is top-level and authoritative; a disagreeing local read must not win.
  assert.equal(keyboardInset({ occludedBottom: KBD_H }, shrinkWin), KBD_H);
});

test('embedded with no host geometry measures 0 — the bug the host bridge fixes', () => {
  assert.equal(keyboardInset(null, embeddedWin), 0);
  // Documented consequence: the button rests at the base bottom, i.e. on the keys.
  assert.equal(ctrlPasteBottom(keyboardInset(null, embeddedWin), 0), CTRL_BASE_BOTTOM.kbd);
});

test('embedded WITH host geometry lifts the button clear of the keyboard', () => {
  const bottom = ctrlPasteBottom(keyboardInset({ occludedBottom: KBD_H }, embeddedWin), 0);
  assert.ok(bottom > KBD_H, `${bottom}px clears a ${KBD_H}px keyboard`);
  assert.ok(bottom < KBD_H + 40, 'and sits just above it, not floating in the middle');
});

test('top-level overlay keyboard is measured locally, no host needed', () => {
  assert.equal(keyboardInset(null, overlayWin), KBD_H);
});

test('a shrinking layout viewport correctly reports ~0 occlusion', () => {
  // The viewport bottom IS the keyboard top here, so the base bottom is already
  // above the keys — adding the keyboard height again would fling the button
  // off-screen (the regression that shot it to the top).
  assert.equal(keyboardInset(null, shrinkWin), 0);
  assert.equal(ctrlPasteBottom(0, 0), CTRL_BASE_BOTTOM.kbd);
});

test('a garbage host value falls through to the local measurement', () => {
  // The host number is untrusted input off a postMessage channel.
  assert.equal(keyboardInset({ occludedBottom: NaN }, overlayWin), KBD_H);
  assert.equal(keyboardInset({ occludedBottom: undefined }, overlayWin), KBD_H);
  assert.equal(keyboardInset({ occludedBottom: -50 }, overlayWin), 0, 'negative clamps, never lifts downward');
});

test('a dragged group keeps its offset while lifted above the keyboard', () => {
  const lift = 120;
  assert.equal(ctrlPasteBottom(KBD_H, lift) - ctrlPasteBottom(KBD_H, 0), lift);
});

test('the drag threshold is big enough to survive a normal tap wobble', () => {
  // A finger never holds perfectly still on a 44px target; too small a slop would
  // turn taps into drags and swallow the button's action.
  assert.ok(DRAG_SLOP >= 6 && DRAG_SLOP <= 16, `DRAG_SLOP=${DRAG_SLOP} is in a sane range`);
});
