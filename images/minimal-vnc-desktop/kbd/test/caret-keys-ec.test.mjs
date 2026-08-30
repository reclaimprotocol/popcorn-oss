// caret-keys-ec.test.mjs — the same caret guarantee on the EditContext path.
// See caret-keys.test.mjs for why forwarding alone is not enough.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, fireEC, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-ec');

const LEFT = 0xff51, HOME = 0xff50, DEL = 0xffff;
const RECT = { x: 0, y: 0, w: 10, h: 10 };

function focusField() {
  pushSignal({ editable: true, focusKey: 'f1', rect: RECT,
    hints: { tag: 'INPUT', type: 'text' }, sync: { sensitive: false, len: 0 } });
}

test('caret keys reach the remote from the EditContext surface', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField();
  rfb.clearKeys();
  for (const key of ['ArrowLeft', 'Home', 'Delete']) fire(proxy, 'keydown', { key });
  assert.deepEqual(rfb.tapped(), [LEFT, HOME, DEL]);
});

test('the EditContext buffer is reset with the caret', async () => {
  const { proxy, rfb } = await freshViewer(createMockRfb);
  focusField();
  proxy.editContext.text = 'helo';
  fireEC(proxy.editContext, 'textupdate', { text: 'helo', updateRangeStart: 0, updateRangeEnd: 0 });
  rfb.clearKeys();
  fire(proxy, 'keydown', { key: 'ArrowLeft' });
  assert.equal(proxy.editContext.text, '', 'buffer cleared so the next delta is fresh');
  proxy.editContext.text = 'l';
  fireEC(proxy.editContext, 'textupdate', { text: 'l', updateRangeStart: 0, updateRangeEnd: 0 });
  assert.deepEqual(rfb.tapped(), [LEFT, ...keysymsFor('l')], 'a plain insert, no backspaces');
});
