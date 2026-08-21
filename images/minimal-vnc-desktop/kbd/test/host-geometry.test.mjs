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
  installGlobals, freshViewer, fire, fireViewport, setVisualViewportHeight,
  parentMessages, fireHostMessage, advanceClock, tickIntervals,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('ios', { embedded: true, search: '?parentOrigin=https://portal.test' });

function lastViewportMsg() {
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    if (parentMessages[i].type === 'POPCORN_VIEWPORT') return parentMessages[i];
  }
  return null;
}

function hostGeometry(visibleHeight, occludedBottom, extra) {
  fireHostMessage(Object.assign(
    { type: 'POPCORN_HOST_GEOMETRY', visibleHeight, occludedBottom }, extra || {}));
}

test('host geometry latches the keyboard and reports the occlusion it was given', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus(); // the keyboard is OURS — see the ownership test below
  parentMessages.length = 0;
  hostGeometry(500, 344);
  const msg = lastViewportMsg();
  assert.ok(msg, 'POPCORN_VIEWPORT posted from host geometry');
  assert.equal(msg.visibleHeight, 500);
  assert.equal(msg.occludedBottom, 344);
});

// Device report sid=5dmfqoah: "host geom occ=283 -> kbd=true" alternating with
// "watchdog: proxy lost focus -> dismiss" until the session dropped. Whatever
// makes the host report a keyboard, the watchdog must not close one it can SEE.
test('a host-reported occlusion is not torn down by the focus watchdog', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  hostGeometry(500, 283);
  globalThis.document.activeElement = null; // focus gone, keys still on screen
  parentMessages.length = 0;
  tickIntervals();
  tickIntervals();
  tickIntervals();
  const dismissed = parentMessages.some((m) => m.type === 'POPCORN_KBD_STATE' && m.active === false);
  assert.equal(dismissed, false,
    'the watchdog did not dismiss while the host still reports keys on screen');
});

// Same report: a stable occ=283 for 12s with NO touch in this frame for the
// preceding 16s. A soft keyboard only opens for a focused local element and the
// proxy is the only one here, so those keys were the EMBEDDING page's — and
// latching them pointed our lift and watchdog at a keyboard we cannot type into.
test('an occlusion with no focus of ours is the embedder keyboard, not ours', async () => {
  await freshViewer(createMockRfb);
  globalThis.document.activeElement = null; // we own no focus, so we raised nothing
  parentMessages.length = 0;
  hostGeometry(500, 283);
  assert.equal(lastViewportMsg(), null,
    'a keyboard we did not raise never becomes our keyboard state or our lift');
  // Invisible from up there otherwise. reportHealth() drops codes missing from
  // its allowlist, so assert the posted message rather than the call.
  const health = parentMessages.filter((m) => m.type === 'POPCORN_KBD_HEALTH');
  assert.ok(health.some((m) => m.code === 'host-occlusion-not-ours'),
    'the integration problem was reported to the host');
});

test('an occlusion is not ours when the focus has left the FRAME, not just the proxy', async () => {
  // activeElement keeps naming our proxy after the embedder takes the focus, so
  // the proxy check alone would call the portal's keyboard ours.
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  globalThis.document.hasFocus = () => false;   // the portal focused its own input
  parentMessages.length = 0;
  hostGeometry(500, 283);
  assert.equal(lastViewportMsg(), null, 'keys drawn for the page above us are not our keyboard');
  globalThis.document.hasFocus = () => true;
  parentMessages.length = 0;
  hostGeometry(500, 283);
  assert.ok(lastViewportMsg(), 'and once the focus is genuinely ours again it latches');
});

// focusInFrame is the embedder ANSWERING ownership instead of us inferring it —
// and the only signal that survives a webview with no document.hasFocus().
test('an explicit focusInFrame:false outranks every local signal', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  globalThis.document.hasFocus = () => true;   // locally everything says "ours"
  parentMessages.length = 0;
  hostGeometry(500, 283, { focusInFrame: false });
  assert.equal(lastViewportMsg(), null, 'the host owns the other half of focus — believe it');
  hostGeometry(500, 283, { focusInFrame: true });
  assert.ok(lastViewportMsg(), 'and its yes latches normally');
});

test('focusInFrame:true is enough where document.hasFocus() does not exist', async () => {
  // The local inference has to fail open where hasFocus is missing, so only the
  // explicit answer makes the gate trustworthy rather than merely permissive.
  const { proxy } = await freshViewer(createMockRfb);
  const saved = globalThis.document.hasFocus;
  delete globalThis.document.hasFocus;
  try {
    proxy.focus();
    parentMessages.length = 0;
    hostGeometry(500, 283, { focusInFrame: true });
    assert.ok(lastViewportMsg(), 'our keyboard, on the host authority alone');
    parentMessages.length = 0;
    hostGeometry(500, 283, { focusInFrame: false });
    assert.equal(lastViewportMsg(), null, 'and not ours when it says so');
  } finally { globalThis.document.hasFocus = saved; }
});

test('a malformed focusInFrame is treated as absent, not as an assertion', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  globalThis.document.hasFocus = () => true;
  parentMessages.length = 0;
  hostGeometry(500, 283, { focusInFrame: 'nope' });
  assert.ok(lastViewportMsg(), 'garbage falls back to the local inference, which says ours');
});

test('a foreign occlusion leaves NO keyboard state behind for its zero to tear down', async () => {
  // The gate runs BEFORE hostSawOccluded, so the episode is a no-op rather than
  // a latch plus a dismissal.
  await freshViewer(createMockRfb);
  globalThis.document.activeElement = null;
  parentMessages.length = 0;
  hostGeometry(500, 283);          // embedder's keyboard
  hostGeometry(844, 0);            // ...and it closes again
  await advanceClock(900);         // past HOST_ZERO_CONFIRM_MS
  assert.equal(lastViewportMsg(), null,
    'no latch, so no dismissal either — the episode never touched our state');
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

test('persistent occludedBottom 0 with no recent input dismisses after confirmation', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  hostGeometry(500, 344);
  advanceClock(3000); // no recent proxy input -> a real dismissal, not a float
  parentMessages.length = 0;
  hostGeometry(844, 0);
  assert.equal(globalThis.document.activeElement, proxy, 'single zero is held, not acted on');
  assert.equal(lastViewportMsg(), null, 'no transient zero viewport was published');
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.notEqual(globalThis.document.activeElement, proxy, 'proxy blurred on host-reported dismiss');
  const msg = lastViewportMsg();
  assert.equal(msg.occludedBottom, 0);
});

test('transient host zero after input preserves positive geometry and lift state', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  hostGeometry(500, 344);
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertText' });
  parentMessages.length = 0;

  hostGeometry(844, 0);
  const bridge = await import('../host-bridge.js');
  assert.equal(bridge.hostGeometry().occludedBottom, 344,
    'last positive geometry remains effective during zero confirmation');
  assert.equal(lastViewportMsg(), null, 'transient zero is not published');
  assert.equal(globalThis.document.activeElement, proxy, 'keyboard remains focused');

  hostGeometry(500, 344); // iOS viewport animation settles before confirmation
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(bridge.hostGeometry().occludedBottom, 344, 'positive geometry won');
  assert.equal(globalThis.document.activeElement, proxy, 'cancelled timer did not dismiss later');
});

test('persistent host zero with recent input becomes floating without dismissal', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  hostGeometry(500, 344);
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertText' });
  parentMessages.length = 0;

  hostGeometry(844, 0);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(globalThis.document.activeElement, proxy, 'floating keyboard remains focused');
  assert.equal(lastViewportMsg().occludedBottom, 0, 'persistent zero eventually clears the lift');
});

test('explicit dismissal cancels a pending host-zero confirmation immediately', async () => {
  const { kbd, proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  hostGeometry(500, 344);
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertText' });
  hostGeometry(844, 0);

  kbd.toggle();
  assert.notEqual(globalThis.document.activeElement, proxy, 'explicit dismiss does not wait for debounce');
  parentMessages.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(lastViewportMsg(), null, 'cancelled zero timer emitted no late viewport update');
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
  await new Promise((resolve) => setTimeout(resolve, 750));
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

test('lifecycle acknowledgements are accepted only from the configured parent', async () => {
  await freshViewer(createMockRfb);
  const { onLifecycleAck } = await import('../host-bridge.js');
  const seen = [];
  onLifecycleAck((seq) => seen.push(seq));

  fireHostMessage({ type: 'POPCORN_HOST_ACK', seq: 7 });
  fireHostMessage(
    { type: 'POPCORN_HOST_ACK', seq: 8 },
    { origin: 'https://attacker.test' },
  );
  fireHostMessage(
    { type: 'POPCORN_HOST_ACK', seq: 9 },
    { source: { notTheParent: true } },
  );
  fireHostMessage({ type: 'POPCORN_HOST_ACK', seq: 0 });

  assert.ok(seen.length > 0);
  assert.ok(seen.every((seq) => seq === 7));
  onLifecycleAck(null);
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
