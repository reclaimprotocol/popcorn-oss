// stale-socket-callbacks.test.mjs — regression: a callback from a socket that has
// already been REPLACED must not touch the replacement's state.
//
// Both channels recover from a stall the same way: close the wedged socket and
// dial a new one in the same turn. But close/error fire a task LATER, in the
// browser, by which time the module's `sock`/`inputSock` is the replacement. The
// dead socket's handler then ran against the live socket's state and undid the
// recovery it had just triggered:
//
//   * it cleared the connect-stall watchdog, which was a SHARED handle owned by
//     the newest dial — so if the replacement also hung, nothing was left to
//     break it and the channel wedged permanently;
//   * it called stopPinging(), killing the replacement's RTT/keep-alive loop, so
//     lastKbdMsgAt froze and the 45s stale watchdog reaped a perfectly healthy
//     socket;
//   * it nulled the socket and scheduled another reconnect, turning a channel
//     that had just come back up into a down one.
//
// The stub fires onclose synchronously, so each test below saves the handler and
// suppresses close(), which is what reproduces the real (asynchronous) ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireDoc, fireWindow, makeScreen,
  webSockets, intervals, tickIntervals, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const { createSignal } = await import('../signal.js');

const socketsFor = (suffix) => webSockets.filter((s) => s.url.endsWith(suffix));

// Turn a socket into one whose close() does NOT synchronously call back — the
// real browser ordering, and the only way to observe the race.
function deferClose(s) {
  const saved = s.onclose;
  s.close = function () { this.readyState = 3; };
  return saved;
}

test('/kbd: a stale close after the replacement has started leaves the replacement alone', async () => {
  const signals = [];
  const sig = createSignal({
    applySignal: (m) => signals.push(m),
    applyDialog: () => {},
    applyPopup: () => {},
    kickInput: () => {},
    getInputSock: () => null,
  });

  const before = socketsFor('/kbd').length;
  sig.connectSignal();
  const s1 = socketsFor('/kbd').at(-1);
  assert.ok(s1, 'dialed');

  // s1 hangs mid-upgrade and goes overdue — the state a kick exists to break.
  s1.readyState = 0; // CONNECTING
  const staleOnClose = deferClose(s1);
  advanceClock(9000);

  sig.kickReconnects();
  const s2 = socketsFor('/kbd').at(-1);
  assert.notEqual(s2, s1, 'a replacement was dialed');
  assert.equal(socketsFor('/kbd').length, before + 2, 'exactly one replacement');

  // The replacement comes up and starts its ping loop.
  s2.onopen();
  assert.equal(sig.isOpen(), true, 'replacement is the live socket');
  s2.sent.length = 0;

  // ...and only NOW does the dead socket's close land.
  staleOnClose({ code: 1006 });

  assert.equal(sig.isOpen(), true, 'the stale close did not null the live socket');
  assert.equal(sig.sendControl({ t: 'x' }), true, 'control frames still go out');
  assert.equal(socketsFor('/kbd').length, before + 2, 'no spurious extra reconnect was dialed');

  // The decisive one: the replacement's ping loop must still be running. This is
  // what stopPinging() in the stale handler used to kill, which then starved
  // lastKbdMsgAt and got the healthy socket reaped 45s later.
  tickIntervals();
  const pings = s2.sent.filter((m) => JSON.parse(m).t === 'ping');
  assert.ok(pings.length > 0, 'the replacement is still pinging');
});

test('/kbd: a stale message from a replaced socket is ignored', async () => {
  const signals = [];
  const sig = createSignal({
    applySignal: (m) => signals.push(m),
    applyDialog: () => {}, applyPopup: () => {}, kickInput: () => {}, getInputSock: () => null,
  });
  sig.connectSignal();
  const s1 = socketsFor('/kbd').at(-1);
  const onmessage = s1.onmessage;
  s1.readyState = 0;
  deferClose(s1);
  advanceClock(9000);
  sig.kickReconnects();
  const s2 = socketsFor('/kbd').at(-1);
  s2.onopen();

  onmessage({ data: JSON.stringify({ open: true, from: 'dead socket' }) });
  assert.equal(signals.length, 0, 'a replaced socket cannot push state');
});

test('/input: the watchdog replacement survives the old socket closing late', async () => {
  await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');

  const before = socketsFor('/input').length;
  const s1 = socketsFor('/input').at(-1);
  assert.ok(s1, 'the viewer dialed /input');

  s1.readyState = 0; // hung upgrade
  const staleOnClose = deferClose(s1);
  advanceClock(9000); // ...and overdue

  fireWindow('online'); // kick -> replace
  const s2 = socketsFor('/input').at(-1);
  assert.notEqual(s2, s1, 'a replacement was dialed');
  assert.equal(socketsFor('/input').length, before + 1, 'exactly one replacement');

  s2.readyState = 1;
  s2.sent.length = 0;

  staleOnClose({ code: 1006 }); // the dead socket finally reports

  assert.equal(socketsFor('/input').length, before + 1,
    'the stale close did not schedule a redundant redial');

  // And the live channel still carries touch. If the stale handler had nulled
  // inputSock, every one of these would be dropped instead.
  fireDoc('touchstart', { touches: [{ clientX: 40, clientY: 60 }], changedTouches: [{ clientX: 40, clientY: 60 }], target: canvas });
  fireDoc('touchend', { touches: [], changedTouches: [{ clientX: 40, clientY: 60 }], target: canvas });
  assert.ok(s2.sent.length > 0, 'touch still goes out over the replacement');
});
