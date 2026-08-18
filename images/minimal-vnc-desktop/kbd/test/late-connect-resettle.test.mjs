// late-connect-resettle.test.mjs — characterization: a LATE rfb handshake must
// still get the remote viewport converged.
//
// startMagnify converges the emulation + framebuffer size with settle() at 0,
// 800 and 2500ms after attach. That assumed the RFB comes up inside ~2.5s. On a
// slow cold start it does not — measured 8866ms on a page reload — so all three
// attempts ran against a pod that was not reachable yet, and NOTHING ever tried
// again: the framebuffer stayed at the Xvnc desktop size, the page was never
// rendered at the phone's width, and there was no recovery path. The symptom was
// a permanently cropped legacy page after a reload.
//
// Direct unit test of createFit with mock deps (same rig as fit-latch.test.mjs):
// the full-viewer path would need the whole magnify/canvas timer rig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' }); // MAGNIFY on

const { createFit } = await import('../fit.js');

function makeFit() {
  const posts = [];
  // Capture the /emulate POSTs instead of the blanket ok-stub, so the test can
  // assert that a SECOND request is actually issued.
  globalThis.fetch = (url, opts) => {
    if (String(url).endsWith('/emulate')) posts.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true });
  };
  const screen = { style: {}, offsetWidth: 390, offsetHeight: 844, querySelector: () => null };
  const rfb = { resizeSession: false, scaleViewport: false };
  const fit = createFit({
    getRfb: () => rfb,
    getScreenElement: () => screen,
    getKeyboardActive: () => false,
    vt: {
      resetTransform() {}, applyZoomSnap() {}, minZoom: () => 1, zoomScale: () => 1,
      composeScreenTransform() {}, setFillFloor() {}, clampPan() {},
    },
    setMagEligible: () => {},
    updateControlButtons: () => {},
    onNavChanged: () => {},
  });
  return { fit, rfb, posts };
}

test('a late rfb connect re-pushes the emulation the early settles could not deliver', () => {
  const { fit, rfb, posts } = makeFit();

  // Startup: this is the POST that, on a slow cold start, reaches a pod whose
  // CDP is not attached yet. It still answers OK, which latched lastEmulateKey.
  fit.pushEmulate();
  assert.equal(posts.length, 1, 'startup emulation was pushed');

  // Proof the key is latched: an identical re-push is deduped to nothing. This is
  // what made the naive "just call pushEmulate again" fix a silent no-op.
  fit.pushEmulate();
  assert.equal(posts.length, 1, 'an identical re-push is deduped');

  // The handshake finally lands, seconds after the last scheduled settle.
  fit.resettleOnConnect();

  assert.equal(posts.length, 2, 'the late connect forced a fresh emulation POST');
  assert.deepEqual(
    { width: posts[1].width, height: posts[1].height },
    { width: 390, height: 844 },
    'and it targets the phone viewport, not the desktop framebuffer',
  );
  assert.equal(rfb.resizeSession, true, 'framebuffer resize is re-enabled so it converges');
});

test('it stays a no-op in fit mode, which owns the resize state itself', () => {
  const { fit, rfb, posts } = makeFit();
  // Enter the 980px desktop fallback: fit deliberately holds a WIDE framebuffer,
  // so a resettle must not re-enable resizeSession and shrink it back.
  fit.enterFit(980, 980, false, true, true);
  assert.equal(fit.fitMode(), true);
  rfb.resizeSession = false;
  const before = posts.length;

  fit.resettleOnConnect();

  assert.equal(rfb.resizeSession, false, 'fit keeps ownership of resizeSession');
  assert.ok(posts.length >= before, 'emulation may be re-pushed at the fit width');
  if (posts.length > before) {
    assert.equal(posts.at(-1).width, 980, 'and it is the fit width, not the viewport');
  }
});
