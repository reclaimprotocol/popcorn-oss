// desktop-host-paste.test.mjs — characterization: an embedded DESKTOP viewer
// accepts the portal's own paste button (POPCORN_PASTE). Own file because the
// host bridge needs an embedded + ?parentOrigin= profile, and env.js freezes the
// viewer mode once per process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireHostMessage, pushSignal, clearWindowListeners } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('desktop', { embedded: true, search: '?parentOrigin=https://portal.test' });

// Each freshViewer() adds another window 'message' listener while host-bridge
// stays shared per process, so the prior test's bridge would double-deliver into
// the newest handler table. Harness-only — setup() is `initialized`-guarded.
async function viewer() {
  clearWindowListeners();
  return freshViewer(createMockRfb);
}

test('POPCORN_PASTE from the configured embedder reaches the remote', async () => {
  const { rfb } = await viewer();
  fireHostMessage({ type: 'POPCORN_PASTE', text: 'from the portal' });
  // No field known-focused, so it stages + Ctrl+V rather than typing keysyms.
  assert.deepEqual(rfb.clipboard, ['from the portal']);
});

test('POPCORN_PASTE into a KNOWN focused field types keysyms', async () => {
  const { rfb } = await viewer();
  pushSignal({ editable: true, focusKey: 'h1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: {}, sync: {} });
  rfb.clearKeys();
  fireHostMessage({ type: 'POPCORN_PASTE', text: 'typed' });
  assert.deepEqual(rfb.tapped(), keysymsFor('typed'));
});

test('a long host paste still stages on the remote clipboard + Ctrl+V', async () => {
  const { rfb } = await viewer();
  const text = 'b'.repeat(40);
  fireHostMessage({ type: 'POPCORN_PASTE', text });
  assert.deepEqual(rfb.clipboard, [text]);
  assert.deepEqual(rfb.tapped(), []);
});

test('a paste from the WRONG origin is ignored (inbound fails closed)', async () => {
  const { rfb } = await viewer();
  fireHostMessage({ type: 'POPCORN_PASTE', text: 'evil' }, { origin: 'https://attacker.test' });
  assert.deepEqual(rfb.keys, []);
});
