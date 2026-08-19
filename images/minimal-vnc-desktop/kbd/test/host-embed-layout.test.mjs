// host-embed-layout.test.mjs — the EMBED LAYOUT contract (host/popcorn-host.js).
//
// The bug this locks down: on Android the nested embed
//
//   customer page -> portal frame -> liveview
//
// rendered visibly soft while every number the viewer could report was identical
// to a sharp top-level tab (same framebuffer, same canvas CSS size, zoom 1.00).
// The cause is above the viewer and invisible to it — a mobile compositor
// rasterising the iframe's layer below device scale because the page put that
// layer in a context it treats as cheap: a flex child of a scrolling, transformed
// wrapper. Nothing in the stream is wrong, so nothing in the stream can be
// measured to find it.
//
// So the contract is enforced and checked in the embedder, and these tests are
// about the three properties that make that worth shipping:
//   1. auditLayout() NAMES the hazard for each shape that caused it,
//   2. the compliant shape is reported clean (no false alarms, or an integrator
//      learns to ignore the warning),
//   3. the finding travels — down to the viewer's session log and out to the
//      host's own telemetry — because the person who sees the blur is not the
//      person reading a console on a phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHostWindow } from './host-stub.mjs';

// The shape the contract asks for: position:fixed, full viewport, no border, a
// direct child of <body>, no wrapper.
const COMPLIANT = {
  iframeStyle: { position: 'fixed', borderTopWidth: '0px' },
  iframeRect: { left: 0, top: 0, width: 411, height: 732 },
};

test('the compliant embedding audits clean', () => {
  const h = makeHostWindow(COMPLIANT);
  const a = h.PopcornHost.auditLayout(h.iframe);
  assert.deepEqual(a.issues, [], 'no issues on a plain fixed full-viewport layer');
  assert.equal(a.ok, true);
  assert.equal(a.depth, 0, 'no wrapper elements between the iframe and <body>');
});

test('the measured-soft shape is reported: flex parent + scroll + transform', () => {
  const h = makeHostWindow({
    chain: [{
      style: {
        position: 'fixed', display: 'flex', overflowY: 'auto',
        transform: 'matrix(1, 0, 0, 1, 0, 0)', willChange: 'transform',
      },
      rect: { left: 0, top: 0, width: 411, height: 732 },
    }],
    iframeStyle: { position: 'relative' },
  });
  const a = h.PopcornHost.auditLayout(h.iframe);
  for (const code of ['not-fixed', 'transform', 'will-change', 'scroll-ancestor', 'flex-or-grid-parent', 'nested']) {
    assert.ok(a.issues.includes(code), 'reports ' + code + ' (got ' + a.issues.join(',') + ')');
  }
});

test('each raster-scale hazard is named individually', () => {
  const cases = [
    ['filter', { filter: 'blur(0px)' }],
    ['filter', { backdropFilter: 'saturate(1.2)' }],
    ['zoom', { zoom: '0.99' }],
    ['contain', { contain: 'paint' }],
    ['content-visibility', { contentVisibility: 'auto' }],
    ['opacity', { opacity: '0.999' }],
    ['perspective', { perspective: '800px' }],
    ['clip', { clipPath: 'inset(0 round 8px)' }],
    ['transform', { scale: '1.001' }],
  ];
  for (const [code, style] of cases) {
    const h = makeHostWindow({
      chain: [{ style: Object.assign({ position: 'fixed' }, style), rect: { left: 0, top: 0, width: 411, height: 732 } }],
      iframeStyle: { position: 'fixed' },
    });
    const a = h.PopcornHost.auditLayout(h.iframe);
    assert.ok(a.issues.includes(code), code + ' on an ancestor is reported (got ' + a.issues.join(',') + ')');
  }
});

test('a flex/grid formatting context matters only on the element that sizes us', () => {
  // A flex ancestor further up does not lay the iframe out — its own child does —
  // so flagging it would train integrators to ignore the warning.
  const h = makeHostWindow({
    chain: [
      { style: { position: 'fixed', display: 'flex' }, rect: { left: 0, top: 0, width: 411, height: 732 } },
      { style: { display: 'block' } },
    ],
    iframeStyle: { position: 'fixed' },
  });
  const a = h.PopcornHost.auditLayout(h.iframe);
  assert.ok(!a.issues.includes('flex-or-grid-parent'), 'only the direct parent counts');
  assert.ok(a.issues.includes('nested'), 'the wrapper chain is still reported');
});

test('an iframe smaller than the viewport is reported (a sibling is resizing it)', () => {
  const h = makeHostWindow({
    iframeStyle: { position: 'fixed' },
    // The classic break: a debug/chrome panel takes 200px of height as a LAYOUT
    // sibling, so the stream is scaled into what is left.
    iframeRect: { left: 0, top: 0, width: 411, height: 532 },
    viewport: { w: 411, h: 732 },
  });
  const a = h.PopcornHost.auditLayout(h.iframe);
  assert.ok(a.issues.includes('not-full-viewport'), 'got ' + a.issues.join(','));
  assert.deepEqual(a.css, { w: 411, h: 532 }, 'reports the box it measured');
});

test('layer() applies the contract and reparents a not-yet-loaded frame', () => {
  const h = makeHostWindow({
    chain: [{ style: { display: 'flex', overflowY: 'auto' }, rect: { left: 0, top: 0, width: 411, height: 732 } }],
  });
  h.PopcornHost.layer(h.iframe);
  assert.equal(h.iframe.parentNode, h.body, 'moved out of the wrapper');
  assert.equal(h.iframe.style.position, 'fixed');
  assert.equal(h.iframe.style.width, '100%');
  assert.equal(h.iframe.style.height, '100%');
  assert.equal(h.iframe.getAttribute('scrolling'), 'no');
  assert.deepEqual(h.PopcornHost.auditLayout(h.iframe).issues, [], 'audits clean afterwards');
});

test('a BLANK frame is not a live one — the about:blank document must not block layer()', () => {
  // REGRESSION (reproduced in Chrome on an emulated Pixel 7, host/test-host.html):
  // the documented recipe is "call layer() before setting src", and it did not
  // work. Every parsed <iframe> already has a contentDocument showing about:blank,
  // so the "is this frame live?" guard was true from the start: layer() logged
  // "not reparenting a live frame — call layer() before setting src" at a page
  // that had done exactly that, left the iframe inside the embedder's wrapper, and
  // the audit then reported 'nested'. In the portal that wrapper is a flex +
  // overflow:auto + transformed box, i.e. the raster-scale hazard this whole
  // contract exists to remove — silently unfixed for every integrator using the
  // official API.
  const h = makeHostWindow({
    chain: [{ style: { display: 'flex', overflowY: 'auto', transform: 'matrix(1, 0, 0, 1, 0, 0)' },
              rect: { left: 0, top: 0, width: 411, height: 732 } }],
  });
  h.PopcornHost.layer(h.iframe);           // before src, as the docs say
  assert.equal(h.iframe.parentNode, h.body, 'a blank frame moves out of the wrapper');
  assert.deepEqual(h.PopcornHost.auditLayout(h.iframe).issues, [], 'and the hazards go with it');
  assert.deepEqual(h.warnings, [], 'and it does not warn about a session it would restart');
});

test('a frame navigated WITHOUT a src attribute is still live and stays put', () => {
  // src-less navigation is real (contentWindow.location.replace, a srcdoc bootstrap).
  // The guard must key on where the frame actually IS, not only on the attribute,
  // or the fix above would trade a layout bug for a torn-down session.
  const h = makeHostWindow({
    chain: [{ style: { display: 'flex' }, rect: { left: 0, top: 0, width: 411, height: 732 } }],
  });
  h.iframe.navigate('https://pod.test/liveview.html?magnify=1');
  const wrapper = h.iframe.parentNode;
  h.PopcornHost.layer(h.iframe);
  assert.equal(h.iframe.parentNode, wrapper, 'a live frame is left where it is');
  assert.ok(h.warnings.some((w) => /not reparenting a live frame/.test(w)), 'and it says so');
});

test('layer() refuses to reparent a LOADED frame (that would restart the session)', () => {
  const h = makeHostWindow({
    chain: [{ style: { display: 'flex' }, rect: { left: 0, top: 0, width: 411, height: 732 } }],
  });
  h.iframe.setAttribute('src', 'https://pod.test/liveview.html?magnify=1');
  const wrapper = h.iframe.parentNode;
  h.PopcornHost.layer(h.iframe);
  assert.equal(h.iframe.parentNode, wrapper, 'a live frame is left where it is');
  assert.equal(h.iframe.style.position, 'fixed', 'the styles it CAN fix are still applied');
  assert.ok(h.warnings.some((w) => /not reparenting a live frame/.test(w)), 'and it says so');
});

test('the audit reaches the viewer (and the host) on hello, in codes only', () => {
  const h = makeHostWindow({
    chain: [{ style: { position: 'fixed', display: 'flex', overflowY: 'auto' }, rect: { left: 0, top: 0, width: 411, height: 732 } }],
    iframeStyle: { position: 'relative' },
  });
  const seen = [];
  const host = h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  host.on('layout', (a) => seen.push(a));
  h.fromChild({ type: 'POPCORN_HELLO', protocol: 1, vk: false });

  const down = h.posted.filter((m) => m.type === 'POPCORN_HOST_LAYOUT');
  assert.equal(down.length, 1, 'posted down to the viewer for the session log');
  assert.ok(down[0].issues.includes('flex-or-grid-parent'));
  assert.equal(down[0].reason, 'hello');
  assert.equal(down[0].dpr, 3);
  // Nothing that could carry content: the payload is codes, counts and sizes.
  assert.deepEqual(Object.keys(down[0]).sort(),
    ['cssH', 'cssW', 'depth', 'dpr', 'issues', 'reason', 'top', 'type'].sort());
  assert.equal(seen.length, 1, 'and emitted to the host page\'s own listener');
  assert.ok(h.warnings.some((w) => /rasterise the live view below device scale/.test(w)));
});

test('a late-mounted host requests a fresh hello instead of waiting for a heartbeat', () => {
  const h = makeHostWindow(COMPLIANT);
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  assert.ok(h.posted.some((m) => m.type === 'POPCORN_HELLO_REQUEST'),
    'host immediately requests a hello from an already-booted viewer');
});

test('a clean embedding does not warn, but still reports itself', () => {
  const h = makeHostWindow(COMPLIANT);
  const host = h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  const seen = [];
  host.on('layout', (a) => seen.push(a));
  h.fromChild({ type: 'POPCORN_HELLO', protocol: 1, vk: false });
  assert.ok(!h.warnings.some((w) => /below device scale/.test(w)), 'no false alarm');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
});

test('a MIDDLE frame audits its own embedding — every hop is only as sharp as itself', () => {
  // The three-level chain: this window is the portal, embedded in a customer page
  // (top=false) and embedding the viewer. Its own wrapper is the hazard, and the
  // outer page cannot see it.
  const h = makeHostWindow({
    top: false,
    chain: [{ style: { position: 'fixed', overflowY: 'scroll' }, rect: { left: 0, top: 0, width: 411, height: 732 } }],
    iframeStyle: { position: 'fixed' },
  });
  const host = h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  h.fromChild({ type: 'POPCORN_HELLO', protocol: 1, vk: false });
  const down = h.posted.filter((m) => m.type === 'POPCORN_HOST_LAYOUT');
  assert.equal(down.length, 1);
  assert.ok(down[0].issues.includes('scroll-ancestor'));
  assert.equal(down[0].top, false, 'reported as a middle hop, not the top one');
  host.destroy();
});

test('a parent hop\'s audit is RELAYED down instead of stopping at the middle frame', () => {
  // The outer page's finding is about the outer page's ancestors — the viewer's
  // log is the one place both hops meet, so the middle frame must forward it.
  const h = makeHostWindow({ top: false, ...COMPLIANT });
  h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });
  h.posted.length = 0;
  h.fromParent({ type: 'POPCORN_HOST_LAYOUT', issues: ['transform'], depth: 2, dpr: 3, cssW: 411, cssH: 732, top: true, reason: 'frame' });
  const down = h.posted.filter((m) => m.type === 'POPCORN_HOST_LAYOUT');
  assert.equal(down.length, 1, 'forwarded, not swallowed');
  assert.deepEqual(down[0].issues, ['transform']);
  assert.equal(down[0].top, true, 'still attributed to the top hop');
});

test('the viewer\'s scale report is relayed UP to the embedder', () => {
  const h = makeHostWindow({ top: false, ...COMPLIANT });
  const host = h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test', relay: true });
  const seen = [];
  host.on('scale', (d) => seen.push(d));
  h.fromChild({ type: 'POPCORN_SCALE', fbWidth: 411, fbHeight: 732, cssWidth: 411, cssHeight: 732, dpr: 3, scale: 1, deviceScale: 0.333, reason: 'first-frame' });
  assert.equal(seen.length, 1, 'the middle frame sees it');
  assert.equal(seen[0].deviceScale, 0.333);
  assert.ok(h.parentPosted.some((m) => m.type === 'POPCORN_SCALE'), 'and keeps it travelling up');
});

test('keyboard health is relayed through a portal hop', () => {
  const h = makeHostWindow({ top: false, ...COMPLIANT });
  const host = h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test', relay: true });
  const seen = [];
  host.on('health', (d) => seen.push(d));
  h.fromChild({ type: 'POPCORN_KBD_HEALTH', code: 'focus-stolen', detail: {}, codes: ['focus-stolen'] });
  assert.equal(seen[0].code, 'focus-stolen');
  assert.ok(h.parentPosted.some((m) => m.type === 'POPCORN_KBD_HEALTH'));
});
