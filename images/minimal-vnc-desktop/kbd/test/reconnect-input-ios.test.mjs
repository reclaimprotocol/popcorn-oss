import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fire, pushSignal, advanceClock } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS, ENTER } from './mock-rfb.mjs';

installGlobals('ios');

const FIELD = { editable: true, focusKey: 'field-A', rect: { x: 10, y: 20, w: 100, h: 30 },
  hints: { tag: 'INPUT' }, sync: { len: 0 } };

async function activeViewer() {
  const v = await freshViewer(createMockRfb);
  pushSignal(FIELD);
  v.proxy.focus();
  return v;
}

test('text, deletion and Enter during the soft-detached gap replay exactly once', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  assert.equal(document.activeElement, proxy, 'soft detach retains the active proxy');
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'ab' });
  fire(proxy, 'beforeinput', { inputType: 'deleteContentBackward' });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'c' });
  fire(proxy, 'beforeinput', { inputType: 'insertLineBreak' });
  const next = createMockRfb();
  kbd.attach(next);
  assert.deepEqual(next.tapped(), []);
  next.fireConnect();
  assert.deepEqual(next.tapped(), [...keysymsFor('ab'), BS, ...keysymsFor('c'), ENTER]);
  next.clearKeys();
  next.fireConnect();
  assert.deepEqual(next.tapped(), []);
  kbd.detach();
});

test('held Backspace and keydown Enter preserve their order across the gap', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  fire(proxy, 'keydown', { key: 'Backspace', keyCode: 8 });
  proxy.value = '\u2060'.repeat(119); // native held-delete repeat shrinks the chew buffer
  fire(proxy, 'input', { inputType: 'deleteContentBackward' });
  fire(proxy, 'keydown', { key: 'Enter', keyCode: 13 });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), [BS, BS, ENTER]);
  kbd.detach();
});

test('composition committed in the gap is replayed once', async () => {
  const { kbd, proxy } = await activeViewer();
  fire(proxy, 'compositionstart', {});
  kbd.detach({ soft: true });
  proxy.value = '漢';
  fire(proxy, 'input', { inputType: 'insertCompositionText', isComposing: true });
  fire(proxy, 'compositionend', { data: '漢' });
  fire(proxy, 'input', { inputType: 'insertText' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), keysymsFor('漢'));
  kbd.detach();
});

test('native paste input in the gap uses the same text queue', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  const paste = fire(proxy, 'paste', { clipboardData: { getData: () => 'paste' } });
  assert.equal(paste.defaultPrevented, false, 'native paste may update the retained input');
  proxy.value = 'paste';
  fire(proxy, 'input', { inputType: 'insertFromPaste' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), keysymsFor('paste'));
  kbd.detach();
});

test('queued input expires after five seconds; newer same-field input still replays', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'old' });
  advanceClock(6000);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'new' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), keysymsFor('new'));
  kbd.detach();
});

test('the existing 128-entry bound also applies to soft-detached input', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  for (let i = 0; i < 130; i++) fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'x' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), keysymsFor('x'.repeat(128)));
  kbd.detach();
});

test('a field change drops the old field queue and preserves new-field input', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'private' });
  pushSignal({ ...FIELD, focusKey: 'field-B' });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'new' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), keysymsFor('new'));
  kbd.detach();
});

test('unknown-field input is inert throughout soft detach and pending connect', async () => {
  const { kbd, proxy } = await freshViewer(createMockRfb);
  proxy.focus();
  kbd.detach({ soft: true });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'unknown' });
  fire(proxy, 'compositionend', { data: 'unknown' });
  const next = createMockRfb();
  kbd.attach(next);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'unknown' });
  next.fireConnect();
  assert.deepEqual(next.tapped(), []);
  kbd.detach();
});

test('an inactive proxy cannot enqueue or replay disconnected input', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'queued' });
  proxy.blur();
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'inactive' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), []);
  kbd.detach();
});

test('full teardown clears queued sends, deferred deletes and composition state', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'discard' });
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  fire(proxy, 'compositionstart', {});
  proxy.value = 'discard';
  kbd.detach();
  const next = createMockRfb();
  kbd.attach(next, true);
  pushSignal(FIELD);
  proxy.focus();
  await sleep(120);
  assert.deepEqual(next.tapped(), []);
  assert.equal(proxy.value, '');
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'x' });
  assert.deepEqual(next.tapped(), keysymsFor('x'));
  kbd.detach();
});

test('a deferred delete cannot move to a different or unknown remote field', async () => {
  for (const focusKey of ['field-B', null]) {
    const { kbd, proxy } = await activeViewer();
    kbd.detach({ soft: true });
    fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
    pushSignal({ ...FIELD, focusKey });
    await sleep(120);
    const next = createMockRfb();
    kbd.attach(next, true);
    assert.deepEqual(next.tapped(), []);
    kbd.detach();
  }
});

test('a same-field deferred delete during the gap still replays once', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach({ soft: true });
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  await sleep(120);
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), [BS]);
  kbd.detach();
});

test('full detach followed by a soft detach cannot re-enable absent-transport input', async () => {
  const { kbd, proxy } = await activeViewer();
  kbd.detach();
  pushSignal(FIELD);
  proxy.focus();
  kbd.detach({ soft: true });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'discard' });
  const next = createMockRfb();
  kbd.attach(next, true);
  assert.deepEqual(next.tapped(), []);
  kbd.detach();
});

test('a retired RFB connect cannot flush the queue into an unconnected replacement', async () => {
  const { kbd, proxy, rfb } = await activeViewer();
  kbd.detach({ soft: true });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'x' });
  const next = createMockRfb();
  kbd.attach(next);
  rfb.fireConnect();
  assert.deepEqual(next.tapped(), []);
  next.fireConnect();
  assert.deepEqual(next.tapped(), keysymsFor('x'));
  kbd.detach();
});
