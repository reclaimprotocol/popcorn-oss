// slow-link-input.test.mjs — the hidden-<input> path on a slow link.
//
// CHARACTERIZATION of a gap, not an endorsement of it. commitOnly() is consulted
// in exactly one place, onECTextUpdate, so it only ever throttles the
// EditContext path. The <input> path's equivalent flag, `composedSuppressed`, is
// declared, read in onCompositionEnd and reset there — but never assigned true
// anywhere in the repo, so that flush branch is unreachable and this path mirrors
// every composing step no matter how slow the link is.
//
// That is exactly the per-jamo backspace/retype flooding commitOnly exists to
// prevent, and it still happens on Samsung, Android WebView and older Chromium —
// the browsers most likely to be on a slow connection. Pinned here so the gap is
// visible instead of silent; if the <input> path ever gains commit-only, this
// test should flip and be rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-input');

const { noteRtt, linkLatency } = await import('../latency.js');
noteRtt(2000);
assert.ok(linkLatency() > 700, 'latency seed failed');

test('composing steps are sent immediately even on a slow link', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'f1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { tag: 'INPUT', type: 'text' }, sync: { sensitive: false, len: 0 } });
  rfb.clearKeys();
  fire(proxy, 'compositionstart', {});
  proxy.value = 'ab';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  assert.deepEqual(rfb.tapped(), keysymsFor('ab'),
    'no commit-only on this path: the marked-text step goes straight out');
});

test('a password on a slow link is unaffected by latency', async () => {
  // The credential-relevant half: latency gates only the EC path, so an
  // encrypted (slower) tunnel cannot change how a secret is transmitted.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'pw', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { tag: 'INPUT', type: 'password', autoComplete: 'current-password' },
    sync: { sensitive: true } });
  rfb.clearKeys();
  proxy.value = 'a';   fire(proxy, 'input', { inputType: 'insertText' });
  proxy.value = 'a b'; fire(proxy, 'input', { inputType: 'insertText' });
  assert.deepEqual(rfb.tapped(), keysymsFor('a b'), 'passphrase space intact on a slow link');
});
