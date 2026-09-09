import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('desktop-safari');

const focusField = (key) => pushSignal({ editable: true, focusKey: key,
  rect: { x: 0, y: 0, w: 10, h: 10 }, hints: {}, sync: {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const paste = (proxy, text) => fire(proxy, 'paste',
  { clipboardData: { getData: (type) => (type === 'text/plain' ? text : '') } });
const commandV = (proxy) => fire(proxy, 'keydown',
  { key: 'v', keyCode: 86, ctrlKey: false, shiftKey: false, altKey: false, metaKey: true });

test('Safari waits for its confirmed native paste instead of using the fallback', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('safari-confirmed-paste');
  rfb.clearKeys();
  let reads = 0;
  globalThis.navigator.clipboard.readText = () => { reads++; return Promise.resolve('duplicate'); };

  commandV(proxy);
  await settle();
  assert.equal(reads, 0);
  assert.deepEqual(rfb.tapped(), []);

  paste(proxy, 'once only');
  assert.deepEqual(rfb.tapped(), keysymsFor('once only'));
});

test('Safari accepts repeated native pastes with unchanged clipboard text', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('safari-repeat');
  rfb.clearKeys();

  paste(proxy, 'twice');
  paste(proxy, 'twice');
  assert.deepEqual(rfb.tapped(), keysymsFor('twicetwice'));
});

test('Safari context-menu paste is never mistaken for an earlier event', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('safari-context-menu');
  rfb.clearKeys();

  paste(proxy, 'menu paste');
  await settle();
  paste(proxy, 'menu paste');
  assert.deepEqual(rfb.tapped(), keysymsFor('menu pastemenu paste'));
});
