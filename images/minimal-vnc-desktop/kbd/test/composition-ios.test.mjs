// composition-ios.test.mjs — characterization: CJK/IME composition on the iOS
// <input> path. Marked-text steps must never leak; the commit sends exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('ios');

test('marked-text input events are withheld; compositionend commits once via e.data', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'compositionstart', {});
  proxy.value = 'すい';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  proxy.value = '水';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  assert.deepEqual(rfb.tapped(), []); // nothing mid-composition
  fire(proxy, 'compositionend', { data: '水' });
  assert.deepEqual(rfb.tapped(), keysymsFor('水'));
  assert.equal(proxy.value, ''); // proxy cleared for the next word
});

test('compositionend with EMPTY .data falls back to the proxy value (WebKit quirk)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'compositionstart', {});
  proxy.value = '한글';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  fire(proxy, 'compositionend', { data: '' });
  assert.deepEqual(rfb.tapped(), keysymsFor('한글')); // recovered, not dropped
});

test('a composition step already forwarded via beforeinput is NOT re-sent on empty-data compositionend', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'compositionstart', {});
  // Some keyboards deliver the composed word through beforeinput insertText mid-composition.
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: '水', isComposing: true });
  assert.deepEqual(rfb.tapped(), keysymsFor('水'));
  rfb.clearKeys();
  proxy.value = '水';
  fire(proxy, 'compositionend', { data: '' });
  assert.deepEqual(rfb.tapped(), []); // composedForwarded guard — no duplicate
});

test('IME-owned keys (keyCode 229 / isComposing) are swallowed', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'compositionstart', {});
  proxy.value = 'か';
  fire(proxy, 'keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.deepEqual(rfb.tapped(), []); // Enter commits the candidate, not the remote form
});
