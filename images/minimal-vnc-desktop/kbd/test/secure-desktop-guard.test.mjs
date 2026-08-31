// secure-desktop-guard.test.mjs — the password surface is a MOBILE fix and must
// stay off the desktop proxy.
//
// Desktop has no soft-keyboard prose pipeline to fight: there is no suggestion
// strip, no auto-space and no double-space-to-period to suppress. Making the
// hidden 1px desktop proxy a password field would buy nothing and invite the
// browser's own password manager onto it — the same class of focus theft the iOS
// path avoids by never using type=password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, pushSignal } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('desktop');

test('a credential field never turns the desktop proxy into a password input', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  assert.equal(proxy.type, 'text');
  pushSignal({
    editable: true, focusKey: 'pw1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { tag: 'INPUT', type: 'password', autoComplete: 'current-password' },
    sync: { sensitive: true, len: 0 },
  });
  assert.equal(proxy.type, 'text');
});
