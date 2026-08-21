// iOS must focus its hidden native proxy near the top of the LiveView.  Placing
// it at a bottom remote field makes Safari pan the outer visual viewport after
// the first key and briefly expose the host background below the fixed iframe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireDoc, makeScreen, pushSignal,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', {
  embedded: true,
  search: '?magnify=1&parentOrigin=https://portal.test',
});

test('a bottom-field tap focuses the iOS proxy in the top safe strip', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const field = { x: 40, y: 610, w: 310, h: 56 };
  pushSignal({ editable: false, rects: [field], vw: 390, vh: 844 });
  const point = [{ clientX: 195, clientY: 630, identifier: 1 }];

  fireDoc('touchstart', { touches: point, changedTouches: point, target: screen });
  fireDoc('touchend', { touches: [], changedTouches: point, target: screen });

  assert.equal(proxy.style.left, '175px', 'x remains near the user gesture');
  assert.equal(proxy.style.top, '14px', 'y cannot provoke Safari bottom-field auto-pan');
  assert.equal(globalThis.document.activeElement, proxy, 'the embedded iOS focus path still raises immediately');
});
