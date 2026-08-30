// secure-delete-input.test.mjs — the same delete-on-a-secret guarantee on the
// Android hidden-<input> path (WebView, Samsung, older Chromium), which has no
// EditContext to fall back on. See secure-delete.test.mjs for why an ambiguous
// 'Unidentified' delete has to be honoured on a secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-input');

const RECT = { x: 0, y: 0, w: 10, h: 10 };
const BACKSPACE = 0xff08;
const DEFER_MS = 200;

function focusField({ sensitive, key, hints }) {
  pushSignal({
    editable: true, focusKey: key, rect: RECT,
    hints: hints || { tag: 'INPUT', type: sensitive ? 'password' : 'text' },
    sync: { sensitive, len: sensitive ? undefined : 0 },
  });
}

test('an Unidentified delete on a password reaches the remote', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), [BACKSPACE]);
});

test('a following real character cancels it instead', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertText' });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), keysymsFor('a'), 'no stray backspace before the character');
});

test('Samsung: a composition step with no compositionstart still cancels it', async () => {
  // Samsung Keyboard and several Chinese IMEs fire insertCompositionText without
  // ever firing compositionstart, so the composition flag alone cannot see them.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), keysymsFor('a'));
});

test('typing then deleting leaves the remote holding just the typed prefix', async () => {
  // End to end on a password: two characters, then an ambiguous delete.
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField({ sensitive: true, key: 'pw1' });
  rfb.clearKeys();
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'insertText' });
  proxy.value = 'ab';
  fire(proxy, 'input', { inputType: 'insertText' });
  proxy.value = '';
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  await sleep(DEFER_MS);
  assert.deepEqual(rfb.tapped(), [...keysymsFor('ab'), BACKSPACE]);
});
