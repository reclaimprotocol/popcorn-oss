// WebKit may dispatch paste after the readText fallback, producing an echo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal, advanceClock } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('desktop');

const focusField = (key) => pushSignal({ editable: true, focusKey: key,
  rect: { x: 0, y: 0, w: 10, h: 10 }, hints: {}, sync: {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const nativePaste = (proxy, text) => fire(proxy, 'paste',
  { clipboardData: { getData: (type) => (type === 'text/plain' ? text : '') } });

test('a LATE native paste echoing the readText fallback inserts only once', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('webkit-echo');
  rfb.clearKeys();
  globalThis.navigator.clipboard.readText = () => Promise.resolve('once only');
  fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  await settle(); // fallback wins the race
  nativePaste(proxy, 'once only');
  await settle();
  assert.deepEqual(rfb.tapped(), keysymsFor('once only'));
});

test('the late native paste is still swallowed so it cannot type into the proxy', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('webkit-echo-prevented');
  rfb.clearKeys();
  globalThis.navigator.clipboard.readText = () => Promise.resolve('swallow me');
  fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  await settle();
  const e = nativePaste(proxy, 'swallow me');
  assert.equal(e.defaultPrevented, true);
  assert.equal(proxy.value, '');
});

test('a native paste carrying DIFFERENT text after a fallback still inserts', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('webkit-different');
  rfb.clearKeys();
  globalThis.navigator.clipboard.readText = () => Promise.resolve('first');
  fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  await settle();
  nativePaste(proxy, 'second');
  await settle();
  assert.deepEqual(rfb.tapped(), keysymsFor('firstsecond'));
});

test('two real paste events of the same text both land (only echoes are dropped)', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('webkit-repeat');
  rfb.clearKeys();
  nativePaste(proxy, 'twice');
  nativePaste(proxy, 'twice');
  await settle();
  assert.deepEqual(rfb.tapped(), keysymsFor('twicetwice'));
});

test('a new paste command is not swallowed as the previous fallback echo', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('webkit-fallback-repeat');
  rfb.clearKeys();
  globalThis.navigator.clipboard.readText = () => Promise.resolve('twice');

  // First command falls back; the second receives a native event.
  fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  await settle();
  fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  nativePaste(proxy, 'twice');
  await settle();
  assert.deepEqual(rfb.tapped(), keysymsFor('twicetwice'));
});

test('a late matching paste for a different field is not treated as an echo', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('webkit-field-a');
  rfb.clearKeys();
  globalThis.navigator.clipboard.readText = () => Promise.resolve('same');
  fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  await settle();

  focusField('webkit-field-b');
  nativePaste(proxy, 'same');
  await settle();
  assert.deepEqual(rfb.tapped(), keysymsFor('samesame'));
});

test('the echo guard expires — the same text pasted later is not swallowed', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  focusField('webkit-expiry');
  rfb.clearKeys();
  globalThis.navigator.clipboard.readText = () => Promise.resolve('later');
  fire(proxy, 'keydown', { key: 'v', keyCode: 86, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  await settle();
  advanceClock(2001);
  nativePaste(proxy, 'later');
  await settle();
  assert.deepEqual(rfb.tapped(), keysymsFor('laterlater'));
});
