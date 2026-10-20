import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS, ENTER } from './mock-rfb.mjs';

installGlobals('android-input');

test('Android value-diff text, deletion and Enter survive the null-RFB gap', async () => {
  const { kbd, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'field-A', rect: { x: 10, y: 20, w: 100, h: 30 },
    hints: { tag: 'INPUT' }, sync: { len: 0 } });
  proxy.focus();
  kbd.detach({ soft: true });
  proxy.value = 'ab';
  fire(proxy, 'input', { inputType: 'insertText' });
  proxy.value = 'a';
  fire(proxy, 'input', { inputType: 'deleteContentBackward' });
  fire(proxy, 'keydown', { key: 'Enter', keyCode: 13 });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), [...keysymsFor('ab'), BS, ENTER]);
  kbd.detach();
});
