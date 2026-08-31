// layout-resize-framebuffer.test.mjs — a layout reflow only makes room when the FRAMEBUFFER
// follows it. Own file: the detectors keep module-level state across tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, makeScreen, fireWindow, setVisualViewportHeight,
  pushSignal, parentMessages } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const lastViewportMsg = () => [...parentMessages].reverse()
  .find((m) => m && m.type === 'POPCORN_VIEWPORT') || null;
const translateY = (el) => {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform || '');
  return m ? Math.round(Number(m[2])) : 0;
};

test('a framebuffer that followed the reflow needs no lift and no pan budget', async () => {
  // The scaled-viewer / re-emulated-remote case: the stream really did shrink with our layout,
  // so nothing hides behind the keys and a lift would push the top of the page off-screen.
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  canvas.offsetHeight = 644;
  canvas.clientHeight = 644;
  screen.offsetHeight = 644;
  globalThis.window.innerHeight = 644;
  setVisualViewportHeight(644);
  proxy.focus();
  parentMessages.length = 0;
  fireWindow('resize');

  const msg = lastViewportMsg();
  assert.ok(msg, 'the layout-resize detector ran');
  assert.equal(msg.occludedBottom, 0, 'the layout made room for real — nothing to reach');
  assert.equal(translateY(screen), 0, 'and no transform lift');
});
