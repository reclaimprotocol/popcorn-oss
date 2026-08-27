// webview-nested-kbd.test.mjs — characterization: the viewer embedded two or
// three frames deep inside an Android WebView.
//
// Reported: "it happened on webview with embedded iframe like 2 or 3 embed" —
// tapping a password field opens the keyboard and it closes again, repeatedly.
//
// What makes this cell different from every other embedded deployment:
//
//   * the WebView resizes the LAYOUT viewport for the keyboard (adjustResize),
//     so the viewer's own innerHeight shrinks WITH visualViewport.height —
//     measured on an emulator: 839 -> 527 for both, offsetTop stays 0;
//   * so the embedder is BLIND. popcorn-host.js measure() takes the
//     |innerH - vv.height| < 50 branch, relearns its baseline DOWNWARD to the
//     shrunken height and reports occludedBottom: 0 — and keeps heartbeating
//     that while the keyboard is up;
//   * host geometry is fresh, so hostGeometryActive() suppresses the local
//     visualViewport detector, leaving handleLayoutResize as the only detector
//     that can see this keyboard at all.
//
// These tests pin what must happen in that cell: the keyboard is detected from
// the local layout resize, the blind host's zeros never tear it down, and a real
// dismissal still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireWindow, fireViewport,
  setVisualViewportHeight, parentMessages, fireHostMessage, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

// Android WebView: no VirtualKeyboard API in the subframe, embedded in a host.
installGlobals('android-input', { embedded: true, search: '?kbddebug=1&parentOrigin=https://portal.test' });
globalThis.console = Object.assign({}, globalThis.console, { log() {} }); // dbg mirrors to console under kbddebug
const trace = () => { try { return globalThis.window.__pcnKbdLog(); } catch (_) { return '(no trace)'; } };

const H_REST = 844, H_KBD = 527;

function lastViewportMsg() {
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    if (parentMessages[i].type === 'POPCORN_VIEWPORT') return parentMessages[i];
  }
  return null;
}

// What a blind embedder in a WebView actually posts: it reports the shrunken
// height as the whole visible height, with no occlusion.
function blindHost(visibleHeight) {
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight, occludedBottom: 0 });
}

// The WebView's own keyboard geometry: both viewports move together.
function setLayoutHeight(h) {
  globalThis.window.innerHeight = h;
  setVisualViewportHeight(h);
}

// Every test in this file attaches another viewer into the same global window,
// and the layout detector learns its no-keyboard baseline from the height it
// sees at rest. Settle explicitly at H_REST so a previous test's shrunken height
// cannot become this test's baseline (which silently disables detection).
function settleAtRest() {
  setLayoutHeight(H_REST);
  fireWindow('resize');
  blindHost(H_REST);
}

test('the keyboard is detected from the layout resize even while a blind host heartbeats zero', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  settleAtRest();
  proxy.focus(); // the user tapped a remote field; the viewer holds proxy focus
  parentMessages.length = 0;

  // Keyboard opens: the WebView shrinks the layout viewport under every frame.
  setLayoutHeight(H_KBD);
  blindHost(H_KBD);       // the embedder still cannot see a keyboard
  fireViewport('resize'); // both events fire in this cell
  fireWindow('resize');

  const msg = lastViewportMsg();
  assert.ok(msg, 'the viewer reported a viewport change');
  assert.equal(msg.visibleHeight, H_KBD, 'reported the height the keyboard left');
  assert.equal(globalThis.document.activeElement, proxy,
    'proxy still focused — nothing dismissed the keyboard it just detected');
});

test('a blind host posting zero for the whole keyboard session never tears it down', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  settleAtRest();
  proxy.focus();

  setLayoutHeight(H_KBD);
  fireWindow('resize');
  assert.equal(globalThis.document.activeElement, proxy, 'keyboard detected, proxy focused');

  // The heartbeat continues for the whole time the user is typing.
  for (let i = 0; i < 6; i++) {
    blindHost(H_KBD);
    advanceClock(800);
    blindHost(H_KBD);
  }

  assert.equal(globalThis.document.activeElement, proxy,
    'still focused: a host that never saw an occlusion has nothing to dismiss');
});

test('a real dismissal still ends the keyboard in this cell', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  settleAtRest();
  proxy.focus();

  setLayoutHeight(H_KBD);
  fireWindow('resize');
  advanceClock(3000); // no recent input: a genuine dismissal, not a floating keyboard

  parentMessages.length = 0;
  setLayoutHeight(H_REST); // the keyboard goes away; the layout viewport grows back
  fireWindow('resize');

  assert.notEqual(globalThis.document.activeElement, proxy,
    'proxy blurred on the real dismiss\n--- detector trace ---\n' + trace());
  const msg = lastViewportMsg();
  assert.equal(msg.occludedBottom, 0);
  assert.equal(msg.visibleHeight, H_REST);
});
