// host-geometry.test.mjs — characterization: an EMBEDDED viewer driven by
// host-supplied keyboard geometry (host-bridge.js + kbd-detect.js).
//
// Why this path exists: a cross-origin iframe can have no keyboard rect of its
// own (VK mute without allow="virtual-keyboard", subframe visualViewport that
// never shrinks), so the embedder measures and posts the rect in. These tests
// lock the three properties that make it safe to trust:
//   1. host geometry drives keyboardActive + the lift (the reported occlusion),
//   2. it SUPPRESSES the local detectors rather than racing them (two detectors
//      with slightly different heights is what causes keyboard-open jitter), and
//   3. it FAILS CLOSED — wrong origin, wrong source, or nonsense numbers are
//      ignored, and stale samples hand control back to the local detectors.
//
// iOS profile embedded in a host at https://portal.test — the deployment this
// mechanism is for (no VirtualKeyboard API anywhere, so nothing local can see
// the keyboard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireViewport, setVisualViewportHeight,
  parentMessages, fireHostMessage, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { embedded: true, search: '?parentOrigin=https://portal.test' });

function lastViewportMsg() {
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    if (parentMessages[i].type === 'POPCORN_VIEWPORT') return parentMessages[i];
  }
  return null;
}

function hostGeometry(visibleHeight, occludedBottom) {
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight, occludedBottom });
}

test('host geometry latches the keyboard and reports the occlusion it was given', async () => {
  await freshViewer(createMockRfb);
  parentMessages.length = 0;
  hostGeometry(500, 344);
  const msg = lastViewportMsg();
  assert.ok(msg, 'POPCORN_VIEWPORT posted from host geometry');
  assert.equal(msg.visibleHeight, 500);
  assert.equal(msg.occludedBottom, 344);
});

test('host geometry outranks the local visualViewport detector (no double-drive)', async () => {
  await freshViewer(createMockRfb);
  hostGeometry(500, 344);
  parentMessages.length = 0;
  // A subframe VV event now arrives with a DIFFERENT height. If the local
  // detector were still live it would post its own (conflicting) viewport and
  // bounce the lift between the two values.
  setVisualViewportHeight(600);
  fireViewport('resize');
  assert.equal(lastViewportMsg(), null, 'local VV detector stayed dormant under host geometry');
});

test('occludedBottom 0 with no recent input dismisses; the proxy is blurred', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  hostGeometry(500, 344);
  advanceClock(3000); // no recent proxy input -> a real dismissal, not a float
  parentMessages.length = 0;
  hostGeometry(844, 0);
  assert.notEqual(globalThis.document.activeElement, proxy, 'proxy blurred on host-reported dismiss');
  const msg = lastViewportMsg();
  assert.equal(msg.occludedBottom, 0);
});

test('occludedBottom 0 does NOT dismiss when the host never saw an occlusion', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  // The keyboard is up locally (a tap raised it) but the keys have not appeared
  // yet, so the host's heartbeat still reports occluded=0. Believing that sample
  // tore the keyboard down ~450ms after every raise on device.
  hostGeometry(844, 0);
  hostGeometry(844, 0);
  advanceClock(3000);   // past any recent-input grace
  hostGeometry(844, 0); // a heartbeat, not a dismissal
  assert.equal(globalThis.document.activeElement, proxy, 'keyboard survived heartbeat occ=0');
});

test('once the host HAS seen an occlusion, occ=0 dismisses normally', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  hostGeometry(844, 0);  // pre-keyboard heartbeat: ignored
  hostGeometry(500, 344); // keys arrive
  advanceClock(3000);
  hostGeometry(844, 0);   // real dismissal
  assert.notEqual(globalThis.document.activeElement, proxy, 'proxy blurred on the real dismiss');
});

test('a message from the wrong origin is ignored', async () => {
  await freshViewer(createMockRfb);
  parentMessages.length = 0;
  fireHostMessage(
    { type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 500, occludedBottom: 344 },
    { origin: 'https://attacker.test' },
  );
  assert.equal(lastViewportMsg(), null, 'geometry from an unexpected origin never applied');
});

test('a message from the right origin but the wrong window is ignored', async () => {
  await freshViewer(createMockRfb);
  parentMessages.length = 0;
  fireHostMessage(
    { type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 500, occludedBottom: 344 },
    { source: { notTheParent: true } },
  );
  assert.equal(lastViewportMsg(), null, 'geometry from a non-parent window never applied');
});

test('nonsense geometry is rejected rather than applied as a bogus lift', async () => {
  await freshViewer(createMockRfb);
  parentMessages.length = 0;
  hostGeometry(0, 344);          // zero visible height
  hostGeometry(-100, 50);        // negative
  hostGeometry(500, -20);        // negative occlusion
  hostGeometry(NaN, NaN);        // non-numeric
  assert.equal(lastViewportMsg(), null, 'every malformed sample dropped');
});

test('stale host geometry hands control back to the local detectors', async () => {
  await freshViewer(createMockRfb);
  hostGeometry(500, 344);
  // Past the 8s staleness window: a host that died must not leave the viewer
  // frozen on its last sample — the local detectors have to resume.
  advanceClock(9000);
  parentMessages.length = 0;
  setVisualViewportHeight(600);
  fireViewport('resize');
  const msg = lastViewportMsg();
  assert.ok(msg, 'local VV detector resumed once host geometry went stale');
  assert.equal(msg.visibleHeight, 600);
});
