// detectors.test.mjs — characterization: the visualViewport keyboard detector
// (kbd-detect.js). Android profile: the grow-dismiss path must NOT trust the
// focus guard there (back/swipe-down hides the IME without blurring).
// Observables: POPCORN_VIEWPORT messages posted to the embedding frame and the
// proxy's focus state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fire, fireViewport, setVisualViewportHeight,
  parentMessages, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input'); // no VirtualKeyboard API → VV detector installed

function lastViewportMsg() {
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    if (parentMessages[i].type === 'POPCORN_VIEWPORT') return parentMessages[i];
  }
  return null;
}

test('viewport shrink >50px latches keyboardActive and reports the occluded bottom', async () => {
  await freshViewer(createMockRfb);
  parentMessages.length = 0;
  setVisualViewportHeight(500); // 844 - 500 = 344px keyboard
  fireViewport('resize');
  const msg = lastViewportMsg();
  assert.ok(msg, 'POPCORN_VIEWPORT posted');
  assert.equal(msg.visibleHeight, 500);
  assert.equal(msg.occludedBottom, 344);
});

test('confirmed grow after a shrink dismisses (Android: focus guard is ignored)', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus(); // Android back-button hides the IME WITHOUT blurring
  setVisualViewportHeight(500);
  fireViewport('resize');
  advanceClock(3000); // no recent proxy input — this is a real dismissal
  parentMessages.length = 0;
  setVisualViewportHeight(844);
  fireViewport('resize');
  assert.notEqual(globalThis.document.activeElement, proxy, 'proxy blurred on grow');
  const msg = lastViewportMsg();
  assert.equal(msg.occludedBottom, 0);
});

test('floating/split keyboard: grow with RECENT proxy input keeps the keyboard (no blur)', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  setVisualViewportHeight(500);
  fireViewport('resize');
  // The user is typing on a keyboard that just went non-occluding (Gboard
  // floating / Samsung split): a text event PROVES it is still up.
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertText' });
  parentMessages.length = 0;
  setVisualViewportHeight(844);
  fireViewport('resize');
  assert.equal(globalThis.document.activeElement, proxy, 'keyboard kept — only the lift dropped');
  const msg = lastViewportMsg();
  assert.equal(msg.occludedBottom, 0, 'occlusion reported gone while keyboard stays up');
});

test('a grow with no preceding shrink is ignored (no phantom dismiss)', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  parentMessages.length = 0;
  setVisualViewportHeight(844);
  fireViewport('resize');
  assert.equal(globalThis.document.activeElement, proxy, 'nothing to dismiss');
  assert.equal(lastViewportMsg(), null, 'no viewport message for a no-op');
});
