// host-interaction-tap.test.mjs — characterization: a tap on the stream reports a
// 'click' interaction to an embedding host.
//
// Own file on purpose: document-level touch handlers are registered by each
// viewer's setup() and are only cleared by installGlobals, so a second
// freshViewer() in the same process leaves a stale viewer listening ahead of the
// live one. A gesture test therefore has to be the FIRST viewer in its process
// (same reason slow-link-ec.test.mjs is separate — see ./README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireDoc, makeScreen, parentMessages } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { search: '?magnify=1' }); // TOUCH_INPUT on — the layer owns touch

test('a tap on the stream reports exactly one click', async () => {
  await freshViewer(createMockRfb);
  const screen = makeScreen();
  const pt = (x, y) => [{ clientX: x, clientY: y, identifier: 1 }];
  parentMessages.length = 0;
  fireDoc('touchstart', { touches: pt(100, 200), changedTouches: pt(100, 200), target: screen });
  fireDoc('touchend', { touches: [], changedTouches: pt(100, 200), target: screen });
  const clicks = parentMessages.filter((m) => m.type === 'POPCORN_INTERACTION' && m.kind === 'click');
  assert.equal(clicks.length, 1, 'one click per tap');
});
