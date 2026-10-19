import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fire, fireEC, pushSignal, findSecureProxy } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS, ENTER } from './mock-rfb.mjs';

installGlobals('android-ec');

const FIELD = { editable: true, focusKey: 'field-A', rect: { x: 10, y: 20, w: 100, h: 30 },
  hints: { tag: 'INPUT' }, sync: { len: 0 } };

async function activeViewer() {
  const v = await freshViewer(createMockRfb);
  pushSignal(FIELD);
  v.proxy.focus();
  assert.ok(v.proxy.editContext);
  return { ...v, ec: v.proxy.editContext };
}

function insert(ec, text) {
  ec.text = text;
  fireEC(ec, 'textupdate', { text, updateRangeStart: 0, updateRangeEnd: 0 });
}

test('EditContext text retains gap replay and gains Backspace/Enter parity', async () => {
  const { kbd, proxy, ec } = await activeViewer();
  kbd.detach({ soft: true });
  insert(ec, 'ab');
  fire(proxy, 'keydown', { key: 'Backspace', keyCode: 8 });
  fire(proxy, 'keydown', { key: 'Enter', keyCode: 13 });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), [...keysymsFor('ab'), BS, ENTER]);
  next.clearKeys();
  next.fireConnect();
  assert.deepEqual(next.tapped(), []);
  kbd.detach();
});

test('EditContext composition queued in the gap is not duplicated on compositionend', async () => {
  const { kbd, ec } = await activeViewer();
  kbd.detach({ soft: true });
  fireEC(ec, 'compositionstart', {});
  insert(ec, '가');
  fireEC(ec, 'compositionend', {});
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), keysymsFor('가'));
  kbd.detach();
});

test('the Android password surface retains gap input and is cleared on teardown', async () => {
  const { kbd } = await activeViewer();
  pushSignal({ ...FIELD, hints: { tag: 'INPUT', type: 'password' }, sync: { sensitive: true } });
  const secure = findSecureProxy();
  secure.focus();
  kbd.detach({ soft: true });
  secure.value = 'secret';
  fire(secure, 'input', { inputType: 'insertText' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), keysymsFor('secret'));
  kbd.detach();
  assert.equal(secure.value, '');
});

test('EditContext input for an unknown field is never replayed', async () => {
  const { kbd, proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  kbd.detach({ soft: true });
  insert(proxy.editContext, 'unknown');
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), []);
  kbd.detach();
});

test('full teardown discards EditContext queue, buffer and later detached updates', async () => {
  const { kbd, ec } = await activeViewer();
  kbd.detach({ soft: true });
  fireEC(ec, 'compositionstart', {});
  insert(ec, 'discard');
  kbd.detach();
  assert.equal(ec.text, '');
  insert(ec, 'detached');
  fireEC(ec, 'compositionend', {});
  const next = createMockRfb();
  kbd.attach(next, true);
  pushSignal(FIELD);
  assert.deepEqual(next.tapped(), []);
  insert(ec, 'x');
  assert.deepEqual(next.tapped(), keysymsFor('x'));
  kbd.detach();
});

test('a deferred EditContext delete cannot move to another field', async () => {
  const { kbd, proxy, ec } = await activeViewer();
  kbd.detach({ soft: true });
  ec.text = 'composing';
  fire(proxy, 'keydown', { key: 'Backspace', keyCode: 8 });
  pushSignal({ ...FIELD, focusKey: 'field-B' });
  await sleep(120);
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), []);
  kbd.detach();
});
