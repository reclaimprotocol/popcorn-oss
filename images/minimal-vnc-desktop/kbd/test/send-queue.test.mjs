// send-queue.test.mjs — characterization: the reconnect keystroke queue.
//
// Active, known-field input queues through a soft detach and a replacement
// RFB's pending connect. Entries older than 5s are dropped at replay time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, advanceClock, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS } from './mock-rfb.mjs';

installGlobals('ios');

const FR = { x: 0, y: 0, w: 10, h: 10 };
async function activeFieldViewer() {
  const v = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'A', rect: FR, hints: { tag: 'INPUT' }, sync: { len: 0 } });
  v.proxy.focus();
  return v;
}

test('keystrokes between attach and connect queue and replay in order', async () => {
  const { kbd, proxy } = await activeFieldViewer();
  kbd.detach({ soft: true }); // 3G blip: keyboard stays up

  const rfb2 = createMockRfb();
  kbd.attach(rfb2); // reconnecting — rfb set, 'connect' pending

  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'ab' });
  fire(proxy, 'beforeinput', { inputType: 'deleteContentBackward' });
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'c' });
  assert.deepEqual(rfb2.tapped(), []); // nothing on the wire yet

  rfb2.fireConnect();
  assert.deepEqual(rfb2.tapped(), [...keysymsFor('ab'), BS, ...keysymsFor('c')]);
});

test('entries staler than 5s are dropped on replay', async () => {
  const { kbd, proxy } = await activeFieldViewer();
  kbd.detach({ soft: true });
  const rfb2 = createMockRfb();
  kbd.attach(rfb2);

  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'old' });
  advanceClock(6000); // outage dragged on — user has moved on from that field
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'new' });

  rfb2.fireConnect();
  assert.deepEqual(rfb2.tapped(), keysymsFor('new')); // 'old' never replays
});

test('after full detach, handlers are inert — nothing queues', async () => {
  const { kbd, proxy } = await activeFieldViewer();
  kbd.detach();
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'ghost' });

  const rfb2 = createMockRfb();
  kbd.attach(rfb2);
  rfb2.fireConnect();
  assert.deepEqual(rfb2.tapped(), []);
});

test('reconnect DROPS keys queued for a field the user has since left (no cross-field leak)', async () => {
  const { kbd, proxy } = await activeFieldViewer();
  pushSignal({ editable: true, focusKey: 'A', rect: FR, hints: { tag: 'INPUT' }, sync: { len: 0 } });
  kbd.detach({ soft: true }); // 3G blip; keyboard stays up
  const rfb2 = createMockRfb();
  kbd.attach(rfb2);           // reconnecting: rfb set, connect pending
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'secret' }); // queued, tagged fk='A'
  // During the outage the page moves focus to a DIFFERENT field B.
  pushSignal({ editable: true, focusKey: 'B', rect: FR, hints: { tag: 'INPUT' }, sync: { len: 0 } });
  rfb2.fireConnect();
  assert.deepEqual(rfb2.tapped(), []); // 'secret' must NOT replay into field B
});

test('reconnect DOES replay keys queued for the same field still focused', async () => {
  const { kbd, proxy } = await activeFieldViewer();
  pushSignal({ editable: true, focusKey: 'A', rect: FR, hints: { tag: 'INPUT' }, sync: { len: 0 } });
  kbd.detach({ soft: true });
  const rfb2 = createMockRfb();
  kbd.attach(rfb2);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'abc' }); // tagged fk='A'
  pushSignal({ editable: true, focusKey: 'A', rect: FR, hints: { tag: 'INPUT' }, sync: { len: 0 } }); // still A
  rfb2.fireConnect();
  assert.deepEqual(rfb2.tapped(), keysymsFor('abc'));
});

test('nothing is queued while connected; a repeat connect replays nothing', async () => {
  const { rfb, proxy, kbd } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'x' });
  assert.deepEqual(rfb.tapped(), keysymsFor('x'));
  rfb.clearKeys();
  rfb.fireConnect();
  assert.deepEqual(rfb.tapped(), []);
  kbd.detach();
});
