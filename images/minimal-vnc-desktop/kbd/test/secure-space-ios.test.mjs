// secure-space-ios.test.mjs — a space typed into a SECRET must reach the remote
// on iOS too.
//
// Both gates that decide this — the address-field space filter and the
// sync.sensitive exemption — sit in transport.js sendText, which the iOS path
// funnels through just as the Android one does. Only the Android profile ever
// drove them (see secure-space.test.mjs), so on iOS the difference between "a
// passphrase space survives" and "a login silently loses a character" rested on
// no test at all. iOS reaches sendText from beforeinput rather than a value diff,
// which is exactly the road these guards had never been walked down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('ios');

const RECT = { x: 0, y: 0, w: 10, h: 10 };

function focusField({ sensitive, key, hints }) {
  pushSignal({
    editable: true, focusKey: key, rect: RECT, hints,
    sync: { sensitive, len: sensitive ? undefined : 0 },
  });
}

// The first character is deliberately never a space: the cross-field carry-over
// guard owns that slot (carryover-space-ios.test.mjs).
const type = (proxy, data) => fire(proxy, 'beforeinput', { inputType: 'insertText', data });

test('a passphrase space survives an address-shaped password name', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1',
    hints: { tag: 'INPUT', type: 'password', name: 'user[password]' } });
  type(proxy, 'a');
  rfb.clearKeys();
  type(proxy, ' b');
  assert.deepEqual(rfb.tapped(), keysymsFor(' b'));
});

test('a secret the page ships as type=text is covered by sync.sensitive alone', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw2',
    hints: { tag: 'INPUT', type: 'text', name: 'user_login_secret' } });
  type(proxy, 'a');
  rfb.clearKeys();
  type(proxy, ' b');
  assert.deepEqual(rfb.tapped(), keysymsFor(' b'));
});

test('a real address field still has its spaces dropped', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: false, key: 'em1',
    hints: { tag: 'INPUT', type: 'email', name: 'user[email]' } });
  type(proxy, 'a');
  rfb.clearKeys();
  type(proxy, ' b');
  assert.deepEqual(rfb.tapped(), keysymsFor('b'), 'the address space is still dropped');
});
