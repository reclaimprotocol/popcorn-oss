// secure-space.test.mjs — a space typed into a SECRET must reach the remote,
// whatever the field is named.
//
// The address-field filter drops every space on an email/username box, because a
// Gboard suggestion commits word+SPACE and an invisible trailing space makes the
// site reject a correct address. Its test matches `user` as a whole word — which
// Rails' name="user[password]" satisfies, so it ate passphrase spaces too, and a
// masked field publishes no val/len for anything to notice. Two gates cover it;
// this file drives the second, sync.sensitive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-input');

const RECT = { x: 0, y: 0, w: 10, h: 10 };

function focusField({ sensitive, key, hints }) {
  pushSignal({
    editable: true, focusKey: key, rect: RECT, hints,
    sync: { sensitive, len: sensitive ? undefined : 0 },
  });
}

// The value-diff proxy the way the browser drives it. The first character is
// deliberately never a space: the cross-field carry-over guard owns that slot.
function type(proxy, value) {
  proxy.value = value;
  fire(proxy, 'input', { inputType: 'insertText' });
}

test('a passphrase space survives an address-shaped password name', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1',
    hints: { tag: 'INPUT', type: 'password', name: 'user[password]' } });
  type(proxy, 'a');
  rfb.clearKeys();
  type(proxy, 'a b');
  assert.deepEqual(rfb.tapped(), keysymsFor(' b'));
});

test('a secret the page ships as type=text is covered by sync.sensitive alone', async () => {
  // ime-hints cannot see the secrecy here — type is text and the autocomplete
  // token is absent, so its own exemption does not fire and the name still reads
  // as address-like. The transport gate is what keeps the space.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw2',
    hints: { tag: 'INPUT', type: 'text', name: 'user_login_secret' } });
  type(proxy, 'a');
  rfb.clearKeys();
  type(proxy, 'a b');
  assert.deepEqual(rfb.tapped(), keysymsFor(' b'));
});

test('a real address field still has its spaces dropped', async () => {
  // The exemption must not reinstate the bug the filter exists for: a Gboard
  // suggestion tap on an email box commits the word plus a trailing space, and
  // the site then rejects a perfectly good address.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: false, key: 'em1',
    hints: { tag: 'INPUT', type: 'email', name: 'user[email]' } });
  type(proxy, 'a');
  rfb.clearKeys();
  type(proxy, 'a b');
  assert.deepEqual(rfb.tapped(), keysymsFor('b'), 'the address space should still be dropped');
});
