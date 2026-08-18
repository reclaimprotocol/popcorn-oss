// kbdstate-poll.test.mjs — regression: the /kbdstate HTTP fallback must stay a
// bounded, single-flight head start and never a second source of truth.
//
// The bridge exists because a WebSocket upgrade on the real path to a pod cost
// ~4.3s and the upgrades were served one at a time, so /kbd landed ~13s in and
// the viewer had no editable rects to hit-test a tap against. The first cut of it
// was a plain setInterval, which is three bugs on a gateway that is slow (which
// is exactly when the bridge runs at all):
//
//   * the interval fired whether or not the previous GET had returned, so a slow
//     /kbdstate stacked one more request every 600ms;
//   * those replies then landed OUT OF ORDER, each re-applying an older snapshot
//     over a newer one;
//   * a reply still in flight when the socket finally opened was applied anyway,
//     regressing state the socket already owned.
//
// It also polled immediately, racing a handshake that was merely in progress
// rather than late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, webSockets, advanceClock } from './stub-dom.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const { createSignal } = await import('../signal.js');

const kbdSockets = () => webSockets.filter((s) => s.url.endsWith('/kbd'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A /kbdstate endpoint the test drives by hand. Every other URL keeps the
// blanket ok-stub so /emulate and /klog are unaffected.
function slowKbdState() {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    if (String(url).endsWith('/kbdstate')) {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      calls.push({ opts, resolve, url: String(url) });
      return p;
    }
    return Promise.resolve({ ok: true });
  };
  return calls;
}

// Every signal built here keeps a bridge alive after its test ends, and the
// module clock only ever moves forward — so a leftover bridge eventually goes
// overdue and polls into the NEXT test's recorder. Shut each one down by opening
// its socket, which is the same thing that retires a bridge in production.
const leftovers = [];
function quiesce() {
  while (leftovers.length) {
    const s = leftovers.pop();
    try { s.readyState = 1; if (s.onopen) s.onopen(); } catch (_) {}
  }
}

function makeSignal(sink) {
  quiesce();
  return createSignal({
    applySignal: (m) => sink.push(m),
    applyDialog: () => {}, applyPopup: () => {}, kickInput: () => {}, getInputSock: () => null,
  });
}

// Put the channel in the state the bridge is FOR: dialed, still connecting, and
// past the window in which it should have opened.
function stalledConnect(sig) {
  sig.connectSignal();
  const s = kbdSockets().at(-1);
  s.readyState = 0; // CONNECTING
  advanceClock(2000); // past BRIDGE_GRACE_MS
  leftovers.push(s);
  return s;
}

test('a slow /kbdstate never has more than one request in flight', async () => {
  const sink = [];
  const sig = makeSignal(sink);
  const calls = slowKbdState();
  stalledConnect(sig);

  sig.startStateBridge();
  // Three poll periods (600ms each) with the first request still unanswered.
  await sleep(2100);

  assert.equal(calls.length, 1,
    'the unanswered request blocked every later poll (no pileup)');

  // Answering it releases exactly one more, and no more than one.
  calls[0].resolve({ ok: true, json: () => Promise.resolve({}) });
  await sleep(1000);
  assert.equal(calls.length, 2, 'the next poll only ran after the previous returned');
});

test('each poll carries an abort signal that fires on a bounded timeout', async () => {
  const sig = makeSignal([]);
  const calls = slowKbdState();
  stalledConnect(sig);

  sig.startStateBridge();
  await sleep(800);
  assert.equal(calls.length, 1, 'one request issued');

  const signal = calls[0].opts && calls[0].opts.signal;
  assert.ok(signal, 'an AbortController signal was attached');
  assert.equal(signal.aborted, false, 'not aborted while still inside the budget');

  // The request went out at ~600ms (one poll period), so its 2500ms abort budget
  // expires at ~3100ms. Wait clear of that.
  await sleep(2700);
  assert.equal(signal.aborted, true, 'a hung request is aborted rather than left to wedge the bridge');
});

test('no polling while the handshake is still inside its expected window', async () => {
  const sig = makeSignal([]);
  const calls = slowKbdState();

  sig.connectSignal();
  const young = kbdSockets().at(-1);
  young.readyState = 0; // CONNECTING, and YOUNG — clock not advanced
  leftovers.push(young);
  sig.startStateBridge();
  await sleep(1500);

  assert.equal(calls.length, 0,
    'a handshake that is merely in progress is not second-guessed over HTTP');
});

test('no polling at all while the socket is open', async () => {
  const sig = makeSignal([]);
  const calls = slowKbdState();
  sig.connectSignal();
  kbdSockets().at(-1).onopen();
  sig.startStateBridge();
  await sleep(1400);

  assert.equal(calls.length, 0, 'the socket is authoritative; the bridge stands down');
});

test('a reply that lands after the socket has come and gone cannot regress state', async () => {
  const sink = [];
  const sig = makeSignal(sink);
  const calls = slowKbdState();
  const s = stalledConnect(sig);

  sig.startStateBridge();
  await sleep(800);
  assert.equal(calls.length, 1, 'a poll is in flight');

  // The socket wins the race while that GET is still outstanding, and delivers
  // the CURRENT state.
  s.readyState = 1;
  s.onopen();
  s.onmessage({ data: JSON.stringify({ open: true, gen: 'fresh' }) });
  assert.deepEqual(sink.map((m) => m.gen), ['fresh'], 'socket state applied');

  // ...then the link drops again. This is the case a bare "is the socket OPEN
  // right now?" test cannot see: by the time the stale reply lands the socket is
  // shut, so that check says "no socket, go ahead and apply" — and a snapshot
  // older than what the socket already delivered is written over the top of it.
  s.readyState = 3;
  s.onclose({ code: 1006 });

  calls[0].resolve({ ok: true, json: () => Promise.resolve({ state: { open: false, gen: 'stale' } }) });
  await sleep(300);

  assert.deepEqual(sink.map((m) => m.gen), ['fresh'],
    'the superseded snapshot was dropped, not applied over the live state');
});
