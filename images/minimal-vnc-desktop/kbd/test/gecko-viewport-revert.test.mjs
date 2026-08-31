// gecko-viewport-revert.test.mjs — Gecko's soft keyboard, measured not assumed.
//
// One tap on a bottom-pinned field in Firefox 154 on Android, as reported by the
// page itself (innerHeight stayed 779 the whole time):
//
//   focus       vv.h 779  vv.top   0
//   vv-resize   vv.h 465  vv.top   0     <- keyboard opens
//   vv-scroll   vv.h 465  vv.top 290
//   vv-resize   vv.h 779  vv.top 290     <- REVERTS, and 290+779 > 779: impossible
//   vv-scroll   vv.h 779  vv.top   0     <- and stays reverted
//
// `dumpsys input_method` said mInputShown=true throughout: the keyboard never
// left. Blink settles at the shrunken height instead and stays there, which is
// why the grow-is-a-dismissal rule was safe until Gecko. Believing that grow
// blurred the proxy and closed a keyboard the user was about to type into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireViewport, setVisualViewportHeight, parentMessages,
  advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('firefox-android');

const REST = 844;

function setViewport(height, offsetTop = 0) {
  setVisualViewportHeight(height);
  globalThis.window.visualViewport.offsetTop = offsetTop;
}

function lastViewportMsg() {
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    if (parentMessages[i].type === 'POPCORN_VIEWPORT') return parentMessages[i];
  }
  return null;
}

test('the keyboard survives Gecko reverting the visual viewport under it', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  setViewport(465);            // opens
  fireViewport('resize');
  setViewport(465, 290);       // pans
  fireViewport('scroll');
  advanceClock(3000);          // no recent typing: the floating-keyboard escape cannot help

  setViewport(REST, 290);      // the impossible sample
  fireViewport('resize');
  setViewport(REST, 0);        // and the reverted resting state
  fireViewport('resize');

  assert.equal(globalThis.document.activeElement, proxy,
    'proxy still focused — the IME is still on screen, so the keyboard must stay');
});

test('an impossible sample never drives the lift', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  setViewport(465);
  fireViewport('resize');
  parentMessages.length = 0;

  setViewport(REST, 290);      // offsetTop + height = 1070 > innerHeight 844
  fireViewport('resize');

  const msg = lastViewportMsg();
  if (msg) {
    assert.ok(msg.visibleHeight <= REST,
      `a reported visible height must fit the layout viewport, got ${msg.visibleHeight}`);
  }
});

test('an explicit blur still ends the keyboard on Gecko', async () => {
  // The fix keeps the keyboard against the VIEWPORT only; the explicit paths must
  // still work or Gecko would wedge with a keyboard that cannot be dismissed.
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  setViewport(465);
  fireViewport('resize');
  assert.equal(globalThis.document.activeElement, proxy);

  proxy.blur();
  assert.notEqual(globalThis.document.activeElement, proxy, 'blur is respected');
});
