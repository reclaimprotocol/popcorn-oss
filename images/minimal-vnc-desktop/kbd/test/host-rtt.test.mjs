// host-rtt.test.mjs — characterization for the host bridge's RTT read.
//
// An embedder cannot measure the tunnel round trip itself: a postMessage ping
// only times the in-device hop. POPCORN_RTT_REQUEST must therefore return the
// viewer's OWN measurement (rtt.js), through the same fail-closed inbound gate
// as every other host command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireHostMessage, parentMessages, advanceClock,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';
import { makeHostWindow } from './host-stub.mjs';

installGlobals('ios', { embedded: true, search: '?parentOrigin=https://portal.test' });

const { startPinging, handlePong } = await import('../rtt.js');

const lastRttMsg = () => parentMessages.filter((m) => m.type === 'POPCORN_RTT').at(-1) ?? null;

function freshSocket() {
  return { readyState: 1 /* OPEN */, sent: [], send(data) { this.sent.push(data); } };
}

test('POPCORN_RTT_REQUEST answers with null before any pong was measured', async () => {
  await freshViewer(createMockRfb);
  parentMessages.length = 0;
  fireHostMessage({ type: 'POPCORN_RTT_REQUEST' });
  const msg = lastRttMsg();
  assert.ok(msg, 'POPCORN_RTT posted');
  assert.equal(msg.rttMs, null, 'no measurement yet');
  assert.equal(msg.samples, 0);
});

test('POPCORN_RTT_REQUEST returns the measured tunnel round trip', async () => {
  const s = freshSocket();
  startPinging(s);
  const pingId = JSON.parse(s.sent.at(-1)).id;
  advanceClock(120);
  handlePong({ id: pingId });

  parentMessages.length = 0;
  fireHostMessage({ type: 'POPCORN_RTT_REQUEST' });
  const msg = lastRttMsg();
  assert.ok(msg, 'POPCORN_RTT posted');
  assert.equal(msg.rttMs, 120, 'latest measured round trip');
  assert.ok(msg.samples >= 1, 'sample count carried');
  assert.ok(Number.isFinite(msg.avgMs), 'smoothed latency carried');
});

test('the RTT read obeys the fail-closed inbound gate (wrong origin ignored)', async () => {
  parentMessages.length = 0;
  fireHostMessage({ type: 'POPCORN_RTT_REQUEST' }, { origin: 'https://evil.example' });
  assert.equal(lastRttMsg(), null, 'request from a non-configured origin is dropped');
});

// ---- host side (PopcornHost SDK) ----------------------------------------

test('PopcornHost.requestRtt posts the request and surfaces the reply as .on(\'rtt\')', async () => {
  const h = makeHostWindow({ top: true, iframeStyle: { position: 'fixed' },
    iframeRect: { left: 0, top: 0, width: 411, height: 732 } });
  const host = h.PopcornHost.attach(h.iframe, { childOrigin: 'https://pod.test' });

  const got = [];
  host.on('rtt', (d) => got.push(d));
  host.requestRtt();
  assert.ok(h.posted.some((m) => m.type === 'POPCORN_RTT_REQUEST'), 'request posted to the frame');

  h.fromChild({ type: 'POPCORN_RTT', rttMs: 86, avgMs: 92, samples: 41 });
  assert.equal(got.length, 1, 'rtt event emitted');
  assert.equal(got[0].rttMs, 86);
  assert.equal(got[0].samples, 41);
});
