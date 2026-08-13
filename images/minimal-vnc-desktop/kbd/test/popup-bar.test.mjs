// popup-bar.test.mjs — characterization: the popup close affordance
// (kbd/popup-bar.js).
//
// "Continue with Google" opens a real second window on the remote; emulate.go
// fullscreens it so it is usable on a phone, which removes its own close button.
// Under --kiosk there is no title bar or tab strip either, so without this bar a
// user who changes their mind mid-OAuth has no way back — and because the popup
// lives in the REMOTE browser, reloading the viewer does not clear it.
//
// These pin the parts that make it a safe control: the request contract (what the
// proxy turns into Target.closeTarget), tap ownership (the close tap must not also
// reach the page underneath), and the rule that the bar is only taken down when the
// REMOTE says the popup is gone — not optimistically on tap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

installGlobals('android-input');
const { createPopupBar } = await import('../popup-bar.js');

function harness() {
  const sent = [];
  const bar = createPopupBar({ sendClose: (r) => sent.push(r) });
  return { bar, sent };
}
// The bar registers a pointerdown listener; fire it the way a tap would.
function tap(bar) {
  const el = node();
  let prevented = false, stopped = false;
  (el._listeners.pointerdown || []).forEach((fn) => fn({
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  }));
  return { prevented, stopped };
}
// The stub DOM's body is shared across tests and each harness appends its own
// bar, so take the LATEST one rather than the first.
function node() {
  return document.body.children.filter((c) => c.attributes['data-popcorn-popup-bar']).pop();
}

test('no popup means no bar — it must not float over an ordinary page', () => {
  const { bar } = harness();
  bar.apply({ open: false, seq: 0 });
  const el = node();
  assert.ok(!el || el.style.display === 'none');
  assert.equal(bar.isOpen(), false);
});

test('an open popup shows the bar and a tap sends that popup sequence', () => {
  const { bar, sent } = harness();
  bar.apply({ open: true, seq: 7 });
  assert.equal(node().style.display, 'flex');
  tap(bar);
  assert.deepEqual(sent, [{ seq: 7 }]);
});

test('the close tap is swallowed — it must not click through to the remote page', () => {
  const { bar } = harness();
  bar.apply({ open: true, seq: 1 });
  const { prevented, stopped } = tap(bar);
  assert.ok(prevented, 'default prevented');
  assert.ok(stopped, 'propagation stopped: the tap layer must not forward it');
});

test('owns() claims the bar so the tap layer treats it as viewer chrome', () => {
  const { bar } = harness();
  bar.apply({ open: true, seq: 1 });
  assert.equal(bar.owns(node()), true);
  assert.equal(bar.owns(document.body), false);
  assert.equal(bar.owns(null), false);
});

test('the bar stays up after a tap — only the remote takes it down', () => {
  // Hiding optimistically would strand the user with no button if the request
  // were dropped on a flaky link. The proxy rejects a stale seq, so re-tapping
  // is safe; a vanished button is not recoverable.
  const { bar } = harness();
  bar.apply({ open: true, seq: 3 });
  tap(bar);
  assert.equal(node().style.display, 'flex', 'still shown until Target.targetDestroyed');
  bar.apply({ open: false, seq: 0 });
  assert.equal(node().style.display, 'none');
});

test('a tap with no popup open sends nothing', () => {
  const { bar, sent } = harness();
  bar.apply({ open: true, seq: 2 });
  bar.apply({ open: false, seq: 0 }); // popup closed itself (OAuth completed)
  tap(bar);
  assert.deepEqual(sent, [], 'no request for a window that is already gone');
});

test('a nested popup re-arms the bar with the new sequence', () => {
  // forgetPopup bumps the sequence when a popup underneath becomes foreground,
  // so an in-flight tap for the closed one cannot close the survivor.
  const { bar, sent } = harness();
  bar.apply({ open: true, seq: 4 });
  bar.apply({ open: true, seq: 5 }); // inner popup closed; outer is foreground now
  tap(bar);
  assert.deepEqual(sent, [{ seq: 5 }], 'targets the CURRENT foreground popup');
});

test('reset() clears the bar for a full teardown', () => {
  const { bar } = harness();
  bar.apply({ open: true, seq: 9 });
  bar.reset();
  assert.equal(node().style.display, 'none');
  assert.equal(bar.isOpen(), false);
});
