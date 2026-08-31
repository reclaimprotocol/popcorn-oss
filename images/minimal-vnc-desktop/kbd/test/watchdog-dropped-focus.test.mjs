// watchdog-dropped-focus.test.mjs — regression from a real session (Android,
// embedded viewer, 2-3 frames deep in a WebView).
//
// Reported: "when I try to enter the password the keyboard keeps closing", then
// "user wasn't able to type the password, the keyboard didn't open".
//
// The session trace, five times over at ~3s intervals:
//
//   176117 host geom occ=342 -> kbd=true
//   178118 watchdog: proxy lost focus -> dismiss
//   180850 host geom occ=342 -> kbd=true
//   182850 watchdog: proxy lost focus -> dismiss
//   ...
//
// Note what is NOT in that trace: any `reclaim #` line. The reclaim path was
// gated on the focus having been TAKEN (another element holds it). Here it was
// merely DROPPED — activeElement back to body — which the WebView does while the
// IME stays up, and the embedder kept reporting occludedBottom=342 the whole
// time. So the watchdog dismissed a keyboard that was still on screen, the host
// heartbeat re-latched it, and round it went, with the field unusable.
//
// The keyboard the user can see is the authority: a dropped focus while
// something that CAN measure the keyboard still reports it occluding means
// "take the focus back", not "it went away".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

installGlobals('android-input'); // kbd/env.js reads window at module scope

// Imported AFTER installGlobals, like the other unit tests in this directory.
const { createWatchdog } = await import('../watchdog.js');

// The watchdog polls on a 1s interval; drive it directly instead of waiting.
function harness({ occluding, activeElement }) {
  const proxy = { tagName: 'INPUT', focus() { state.active = proxy; } };
  const body = { tagName: 'BODY' };
  const state = { active: activeElement === 'proxy' ? proxy : body, dismissed: 0, stolenReports: 0 };
  const ticks = [];
  globalThis.document = {
    get activeElement() { return state.active; },
    body,
    hasFocus: () => true,
  };
  globalThis.setInterval = (fn) => { ticks.push(fn); return 1; };
  globalThis.clearInterval = () => {};
  const watchdog = createWatchdog({
    getKeyboardActive: () => true,
    getKeyboardOpening: () => false,
    getKeyboardJustDismissed: () => false,
    getProxy: () => proxy,
    dismissKeyboard: () => { state.dismissed++; },
    reclaimFocus: () => proxy.focus(),
    onFocusStolen: () => { state.stolenReports++; },
    keyboardOccluding: () => occluding(),
  });
  watchdog.start();
  return { state, proxy, body, tick: () => ticks.forEach((fn) => fn()) };
}

test('a dropped focus while the keyboard still occludes reclaims instead of dismissing', () => {
  // The reported cell: focus back on the body, embedder still posting occ=342.
  const h = harness({ occluding: () => true, activeElement: 'body' });

  h.tick();

  assert.equal(h.state.dismissed, 0, 'did not tear down a keyboard that is still on screen');
  assert.equal(h.state.active, h.proxy, 'took the focus back so the field is typable again');
  assert.equal(h.state.stolenReports, 0, 'a dropped focus is not an embedder stealing focus');
});

test('the dismiss loop from the session trace cannot recur', () => {
  const h = harness({ occluding: () => true, activeElement: 'body' });

  // Five rounds of the loop that was observed; the focus is dropped again each
  // time, exactly as the WebView did.
  for (let round = 0; round < 5; round++) {
    h.state.active = h.body;
    h.tick();
  }

  assert.equal(h.state.dismissed, 0, 'no dismissal while the keyboard keeps occluding');
});

test('a keyboard that really went away is still dismissed', () => {
  // Nothing reports an occlusion any more: the keyboard is gone, and the
  // watchdog must still end the session rather than hold it open forever.
  const h = harness({ occluding: () => false, activeElement: 'body' });

  h.tick(); // first miss
  assert.equal(h.state.dismissed, 0, 'one miss is not enough');
  h.tick(); // second miss
  assert.equal(h.state.dismissed, 1, 'dismissed after the second miss, as before');
});

test('a stolen focus still reclaims and still reports the steal', () => {
  const h = harness({ occluding: () => false, activeElement: 'body' });
  h.state.active = { tagName: 'BUTTON' }; // the embedder took it

  h.tick();

  assert.equal(h.state.dismissed, 0);
  assert.equal(h.state.active, h.proxy, 'focus reclaimed');
  assert.equal(h.state.stolenReports, 1, 'the embedder is told its page stole focus');
});

test('reclaims are bounded, so a lost cause still ends', () => {
  const h = harness({ occluding: () => true, activeElement: 'body' });
  h.proxy.focus = () => {}; // the reclaim never lands

  h.tick(); h.tick();       // MAX_RECLAIMS attempts, no success
  assert.equal(h.state.dismissed, 0, 'still trying while attempts remain');
  h.tick(); h.tick();       // attempts exhausted -> two misses -> dismiss
  assert.equal(h.state.dismissed, 1, 'gives up rather than holding a phantom keyboard');
});
