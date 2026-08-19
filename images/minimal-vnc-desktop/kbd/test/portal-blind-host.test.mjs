// portal-blind-host.test.mjs — a misconfigured embedder must not be able to break
// the keyboard.
//
// THE FAILURE, end to end. In the deployed portal the top-level page measures the
// viewport correctly and posts it under its own message type ({type:'parent-viewport',
// innerHeight, viewportHeight}) — a shape nothing in the chain consumed, so the
// geometry died at the portal hop. What happened next is the part that made the
// keyboard look broken rather than merely unassisted:
//
//   1. the portal frame's PopcornHost saw no upstream geometry, timed out its 2s
//      grace, and started measuring ITSELF;
//   2. it is a cross-origin iframe, whose visualViewport does not shrink when the
//      keyboard opens — so it measured occludedBottom:0 and heartbeated that,
//      forever, as an authoritative "there is no keyboard";
//   3. host geometry SUPPRESSES the viewer's own detectors (deliberately — two
//      detectors driving the lift with different heights is what causes
//      keyboard-open jitter), so the viewer's working detectors went quiet;
//   4. result: no lift (the focused field sits behind the keys), no pan budget to
//      reach it, and — because the local-echo pill is positioned relative to the
//      keyboard's top edge — the echo rendered BEHIND the keyboard too. The one
//      mechanism that hides per-keystroke round-trip latency became invisible, so
//      every character appeared only when the remote's pixels came back.
//
// That is "the keyboard is slow, there is delay and lag" and "the keyboard dies
// badly in the portal", from a single dropped message type.
//
// Two independent defences, one on each side, because either alone leaves a hole:
//   * VIEWER (kbd/host-bridge.js): an embedder earns the right to silence the local
//     detectors by reporting a real occlusion at least once. A host that has only
//     ever said "no keyboard" is not a measurer.
//   * HOST (host/popcorn-host.js): a fallback measurer that can see nothing stays
//     SILENT instead of asserting 0, and the legacy parent-viewport message is
//     translated rather than dropped — so the deployed portal works unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireViewport, setVisualViewportHeight,
  parentMessages, fireHostMessage, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';
import { makeHostWindow } from './host-stub.mjs';

installGlobals('android-input', { embedded: true, search: '?magnify=1&parentOrigin=https://portal.test' });

function lastViewport() {
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    if (parentMessages[i].type === 'POPCORN_VIEWPORT') return parentMessages[i];
  }
  return null;
}

// ---- viewer side ---------------------------------------------------------

test('a missing allow="virtual-keyboard" is reported, from the POLICY not the object', async () => {
  // The check that has to be right, because the wrong version of it looks fine:
  // navigator.virtualKeyboard is present in an iframe whether or not the token was
  // granted, and boundingRect is a real 0x0 rect whether the feature was denied or
  // the keyboard is simply closed. Verified in Chrome against an embed with the
  // token missing, where an object-shape check happily reported vk=1. Only the
  // permissions policy answers the question that was actually asked.
  const { resetHealth } = await import('../health.js');
  resetHealth();
  globalThis.document.permissionsPolicy = { allowsFeature: (f) => f !== 'virtual-keyboard' };
  parentMessages.length = 0;
  await freshViewer(createMockRfb);
  const health = parentMessages.filter((m) => m.type === 'POPCORN_KBD_HEALTH');
  assert.ok(health.some((m) => m.code === 'no-virtual-keyboard'),
    'the embedder is told its geometry is load-bearing: ' + JSON.stringify(health.map((m) => m.code)));
  delete globalThis.document.permissionsPolicy;
});

test('and a correctly-permissioned embed says nothing about it', async () => {
  const { resetHealth } = await import('../health.js');
  resetHealth();
  globalThis.document.permissionsPolicy = { allowsFeature: () => true };
  parentMessages.length = 0;
  await freshViewer(createMockRfb);
  assert.ok(!parentMessages.some((m) => m.type === 'POPCORN_KBD_HEALTH' && m.code === 'no-virtual-keyboard'),
    'silence is the healthy case');
  delete globalThis.document.permissionsPolicy;
});

test('a host that has only ever reported occluded=0 does NOT silence the local detectors', () => {
  // The exact wire traffic of the broken portal: a blind fallback measurer
  // heartbeating "no keyboard" while the user's keyboard is actually open.
  return freshViewer(createMockRfb).then(({ proxy }) => {
    proxy.focus();
    fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 732, occludedBottom: 0 });
    fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 732, occludedBottom: 0 });
    parentMessages.length = 0;
    // The viewer's OWN detector now sees the keyboard (visual viewport shrank).
    // Before this fix the fresh host sample outranked it and this produced nothing.
    setVisualViewportHeight(400);
    fireViewport('resize');
    const vp = lastViewport();
    assert.ok(vp, 'the local detector was still allowed to run');
    assert.ok(vp.occludedBottom > 300, 'and reported a real occlusion: ' + JSON.stringify(vp));
  });
});

test('a host that HAS proved it can see the keyboard still owns the lift', async () => {
  // The exclusivity is the point of the mechanism and must survive the fix: once a
  // real embedder is measuring, the local detectors stand down rather than racing it.
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 400, occludedBottom: 332 });
  parentMessages.length = 0;
  setVisualViewportHeight(600); // a conflicting local read
  fireViewport('resize');
  assert.equal(lastViewport(), null, 'local detector stayed dormant under a proven host');
});

test('a PROVEN host that later measures the wrong window is overruled by our own eyes', async () => {
  // The gap the "has it ever seen an occlusion" gate leaves open. Earning
  // authority once is not the same as being right afterwards, and the way this
  // fails in the field is mundane: an embedder that measures its own container
  // instead of the visual viewport, or that keeps heartbeating the LAST keyboard's
  // height after the keyboard changed size (a language switch, a suggestion strip,
  // a floating keyboard being docked). The sample stays fresh and authoritative
  // while the only document that can see the difference is muted, and the lift is
  // wrong by that difference for the rest of the session.
  //
  // Exclusivity still belongs to the VALUE — one source drives the lift, or it
  // jitters. What changes is that it no longer belongs to the EVIDENCE.
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 400, occludedBottom: 332 });
  parentMessages.length = 0;

  // Our own viewport (844 tall in this profile) says the keyboard occludes 244px,
  // not 332. One sample proves nothing — the two sides can catch a keyboard
  // animation at different moments — so the first event must still defer.
  setVisualViewportHeight(600);
  fireViewport('resize');
  assert.equal(lastViewport(), null, 'a single disagreement is not enough to overrule anybody');

  // Sustained past the disagreement window, it is not an animation any more.
  advanceClock(1500);
  fireViewport('resize');
  const vp = lastViewport();
  assert.ok(vp, 'the local detector took the lift');
  assert.ok(Math.abs(vp.occludedBottom - 244) < 20,
    'and drove it from what it can actually see: ' + JSON.stringify(vp));
});

test('a host we merely DISAGREE with slightly is left alone (no flapping)', async () => {
  // A suggestion strip, a rounding difference, a keyboard mid-animation: the two
  // sides will never agree to the pixel, and an override on every small delta
  // would hand the lift back and forth — the exact jitter the exclusivity rule
  // exists to prevent.
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 400, occludedBottom: 332 });
  parentMessages.length = 0;
  setVisualViewportHeight(544);        // local reads 300 vs the host's 332
  fireViewport('resize');
  advanceClock(3000);
  fireViewport('resize');
  assert.equal(lastViewport(), null, 'close enough is still the host\'s call');
});

test('a viewer that can see NOTHING never overrules a host', async () => {
  // The most important non-regression: in a cross-origin iframe the local
  // visualViewport does not shrink, so "I see no keyboard" is what a BLIND
  // detector reports. Positive evidence only — otherwise the blind case would
  // start overriding the one measurer that works, which is the original bug with
  // the sides reversed.
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 400, occludedBottom: 332 });
  parentMessages.length = 0;
  setVisualViewportHeight(844);        // no shrink at all: we cannot see it
  fireViewport('resize');
  advanceClock(3000);
  fireViewport('resize');
  assert.equal(lastViewport(), null, 'silence is not evidence');
});

test('and its later occluded=0 is honoured as a real dismissal', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 400, occludedBottom: 332 });
  advanceClock(3000); // past the recent-input grace
  fireHostMessage({ type: 'POPCORN_HOST_GEOMETRY', visibleHeight: 732, occludedBottom: 0 });
  assert.notEqual(globalThis.document.activeElement, proxy, 'dismissed on the host\'s word');
});

// ---- host side ----------------------------------------------------------

const EMBEDDED_HOST = { top: false, iframeStyle: { position: 'fixed' },
  iframeRect: { left: 0, top: 0, width: 411, height: 732 } };

test('a blind fallback measurer sends NOTHING rather than asserting no-keyboard', async () => {
  // An embedded PopcornHost with no upstream: after its grace it measures itself,
  // and its subframe visualViewport reports the full height whether or not the
  // keyboard is open. Posting that would suppress the viewer's detectors.
  const h = makeHostWindow(EMBEDDED_HOST);
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  h.fromChild({ type: 'POPCORN_HELLO', protocol: 1, vk: false });
  await new Promise((r) => setTimeout(r, 2300)); // past UPSTREAM_GRACE_MS
  const geom = h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY');
  assert.equal(geom.length, 0, 'stayed silent: ' + JSON.stringify(geom));
  assert.ok(h.infos.some((m) => /staying silent/.test(m)), 'and said why, once');
});

test('the same fallback DOES post once it can actually see an occlusion', async () => {
  const h = makeHostWindow(EMBEDDED_HOST);
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  await new Promise((r) => setTimeout(r, 2300)); // past the grace: it measures itself now
  assert.equal(h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY').length, 0);
  // The keyboard opens and this frame's visual viewport DID shrink (Chromium with
  // the allow= attribute, or a same-origin embed) — so its measurement is real and
  // the silence must end. Same instance, driven by the same event a browser sends.
  h.win.visualViewport.height = 400;
  h.fireWindow('resize');
  const geom = h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY');
  assert.equal(geom.length, 1, 'posted the real occlusion');
  assert.equal(geom[0].occludedBottom, 332);
  // And from here its 0 means "dismissed", so a teardown can still be reported.
  h.win.visualViewport.height = 732;
  h.fireWindow('resize');
  const after = h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY');
  assert.equal(after.length, 2, 'the dismissal got through');
  assert.equal(after[1].occludedBottom, 0);
});

test('the legacy parent-viewport message is TRANSLATED, not dropped', () => {
  // Fixes the deployed portal without the portal shipping anything: the numbers are
  // its own, they came from window.parent like every other inbound message, and the
  // only change is the name they travel under.
  const h = makeHostWindow(EMBEDDED_HOST);
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  h.fromParent({ type: 'parent-viewport', innerHeight: 732, viewportHeight: 400, offsetTop: 0 });
  const geom = h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY');
  assert.equal(geom.length, 1);
  assert.equal(geom[0].visibleHeight, 400);
  assert.equal(geom[0].occludedBottom, 332);
  assert.ok(h.infos.some((m) => /legacy parent-viewport/.test(m)));
});

test('a legacy message ALSO stops us falling back to measuring ourselves', async () => {
  // The second half of the break: without this the frame keeps its own blind
  // measuring alive alongside the translated geometry.
  const h = makeHostWindow(EMBEDDED_HOST);
  const host = h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  h.fromParent({ type: 'parent-viewport', innerHeight: 732, viewportHeight: 400, offsetTop: 0 });
  assert.equal(host.mode(), 'relay', 'upstream recognised — we forward, never measure');
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(host.mode(), 'relay', 'and the grace timeout does not undo that');
});

test('a legacy sub-threshold delta is a URL bar, not a keyboard', () => {
  const h = makeHostWindow(EMBEDDED_HOST);
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  h.fromParent({ type: 'parent-viewport', innerHeight: 732, viewportHeight: 700, offsetTop: 0 });
  const geom = h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY');
  assert.equal(geom.length, 1);
  assert.equal(geom[0].occludedBottom, 0, '32px is not a keyboard');
  assert.equal(geom[0].visibleHeight, 732);
});

test('legacy translation can be turned off by a page that owns that message type', () => {
  const h = makeHostWindow(EMBEDDED_HOST);
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test', legacyGeometry: false });
  h.fromParent({ type: 'parent-viewport', innerHeight: 732, viewportHeight: 400 });
  assert.equal(h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY').length, 0);
});

test('a legacy message from anywhere but our own parent is ignored', () => {
  const h = makeHostWindow(EMBEDDED_HOST);
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  h.fromChild({ type: 'parent-viewport', innerHeight: 732, viewportHeight: 400 });
  assert.equal(h.posted.filter((m) => m.type === 'POPCORN_HOST_GEOMETRY').length, 0);
});
