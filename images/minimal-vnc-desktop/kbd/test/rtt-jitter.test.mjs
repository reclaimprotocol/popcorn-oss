// rtt-jitter.test.mjs — characterization for the jittered RTT probe and the
// sample shipper.
//
// Two behaviours are locked here:
//   * SAMPLING IS A PER-SESSION RENEWAL PROCESS. The old fixed setInterval(5000)
//     synchronized every viewer's probes against page-load clusters, so aggregate
//     graphs pulsed. Now each session draws its inter-ping delay uniformly from
//     [2000, 8000]ms — same ~5s mean, decorrelated across sessions. Drawing 2000
//     must fire at exactly 2s (lower bound honoured); drawing ~max must NOT have
//     fired by the old fixed 5s mark (the cadence really changed).
//   * SAMPLES SHIP TO THE PROXY. Every measured pong lands in the rtt-report
//     ring and leaves the page as {sid, t0, samples:[{at, rtt}]} batches to the
//     sibling /rtstats endpoint — offsets from the batch anchor, never absolute
//     wall-clock stamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, webSockets, findKbdSocket, tickIntervals, advanceClock,
} from './stub-dom.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const { startPinging, handlePong } = await import('../rtt.js');
const { noteRtt } = await import('../latency.js');
const rttReport = await import('../rtt-report.js');

const sentPings = (s) => s.sent.filter((m) => JSON.parse(m).t === 'ping').length;
const lastPingId = (s) => JSON.parse(s.sent.filter((m) => JSON.parse(m).t === 'ping').at(-1)).id;

function withRandom(values, fn) {
  const real = Math.random;
  let i = 0;
  Math.random = () => values[Math.min(i++, values.length - 1)];
  try { return fn(); } finally { Math.random = real; }
}

function freshSocket() {
  // Minimal stand-in: only readyState + a recorded send log are needed here.
  return { readyState: 1 /* OPEN */, sent: [], send(data) { this.sent.push(data); } };
}

test('first ping is immediate; the second waits for the drawn delay', () => {
  withRandom([0], () => { // draw -> PING_MIN_MS (2000)
    const s = freshSocket();
    startPinging(s);
    assert.equal(sentPings(s), 1, 'immediate first probe');

    advanceClock(1999);
    tickIntervals(); // one 1s tick inside the drawn window
    assert.equal(sentPings(s), 1, 'no early re-probe inside the drawn window');

    advanceClock(1);
    tickIntervals();
    assert.equal(sentPings(s), 2, 'fires once the full draw has elapsed');
  });
});

test('a max draw survives past the historic fixed 5s cadence', () => {
  withRandom([0.99999], () => { // draw -> ~PING_MAX_MS (~8000)
    const s = freshSocket();
    startPinging(s);
    advanceClock(5000);
    tickIntervals();
    assert.equal(sentPings(s), 1, 'the old fixed-5s mark no longer forces a send');
    advanceClock(3001);
    tickIntervals();
    assert.equal(sentPings(s), 2, 'fires at the drawn ~8s renewal');
  });
});

test('renewals redraw: consecutive gaps follow successive draws', () => {
  // Draws: 2000 (first gap), then 4000-ish (0.5 -> 5000), then min again.
  withRandom([0, 0.5, 0], () => {
    const s = freshSocket();
    startPinging(s);
    advanceClock(2000); tickIntervals(); assert.equal(sentPings(s), 2);
    advanceClock(2000); tickIntervals(); assert.equal(sentPings(s), 2, 'second gap is longer than the first');
    advanceClock(3000); tickIntervals(); assert.equal(sentPings(s), 3, 'second gap completes at 5s');
    advanceClock(2000); tickIntervals(); assert.equal(sentPings(s), 4, 'third gap back at the 2s minimum');
  });
});

test('a closed socket suppresses sends without shifting the schedule', () => {
  withRandom([0], () => {
    const s = freshSocket();
    startPinging(s);
    s.readyState = 3; // CLOSED
    advanceClock(10000);
    tickIntervals();
    assert.equal(sentPings(s), 1, 'nothing is pushed into a dead socket');
  });
});

test('measured pongs reach the report batcher and ship to /rtstats', async () => {
  const posts = [];
  globalThis.fetch = (url, opts) => { posts.push({ url, body: String(opts.body) }); return Promise.resolve({ ok: true }); };

  withRandom([0], () => {
    const s = freshSocket();
    startPinging(s); // immediate probe, sent at t=1000 (clock origin)
    advanceClock(120); // link takes 120ms
    handlePong({ t: 'ping', id: lastPingId(s) });
    assert.equal(rttReport.pendingSampleCount(), 1, 'sample buffered');
  });

  rttReport.flushSamples();
  assert.equal(posts.length, 1, 'one beacon/fetch went out');
  assert.ok(posts[0].url.endsWith('/rtstats'), 'ships to the sibling endpoint');
  const payload = JSON.parse(posts[0].body);
  assert.equal(payload.sid, null, 'non-gateway paths carry no session claim');
  assert.deepEqual(payload.samples, [{ at: 0, rtt: 120 }], 'offsets relative to the anchor, integer ms');
});

test('the gateway session id is parsed from the liveview path', () => {
  const prevPathname = globalThis.location.pathname;
  globalThis.location.pathname = '/liveview/browser-42/some-token/liveview.html';
  try {
    assert.equal(rttReport.sessionIdFromPath(), 'browser-42');
  } finally {
    globalThis.location.pathname = prevPathname;
  }
});

test('batches auto-flush at the cap and overflow stays queued', () => {
  const posts = [];
  globalThis.fetch = (url, opts) => { posts.push({ url, body: String(opts.body) }); return Promise.resolve({ ok: true }); };
  // Drive the batcher directly: the pong->record path is covered above, and
  // tickIntervals() here would also fire the shipper's own 30s flush timer.
  for (let i = 0; i < 130; i++) {
    advanceClock(i % 2 ? 10 : 20); // distinct offsets, sane rtts
    rttReport.recordRttSample(50 + i);
  }
  assert.equal(posts.length, 1, '128-sample batch flushed automatically');
  const first = JSON.parse(posts[0].body);
  assert.equal(first.samples.length, 128);
  assert.equal(rttReport.pendingSampleCount(), 2, 'remainder stays queued for the timer/pagehide flush');
});

test('the timer flush sheds on a constrained link; explicit flushes do not', () => {
  const posts = [];
  globalThis.fetch = (url, opts) => { posts.push({ url, body: String(opts.body) }); return Promise.resolve({ ok: true }); };

  // Struggle the link: the shared EMA crosses diag.js's 700ms shedding line.
  noteRtt(1500); noteRtt(1500); noteRtt(1500); noteRtt(1500);
  rttReport.recordRttSample(1500);

  tickIntervals(); // fires rtt-report's own timer callback
  assert.equal(posts.length, 0, 'timer-driven shipping stands down mid-struggle');
  assert.ok(rttReport.pendingSampleCount() >= 1, 'samples stay queued, not dropped');

  const before = rttReport.pendingSampleCount();
  rttReport.flushSamples(); // pagehide / batch-full paths still ship
  assert.equal(posts.length, 1, 'explicit flush still hands data off');
  assert.equal(rttReport.pendingSampleCount(), Math.max(0, before - 128));
});

test('a stalled fetch never stacks: later flushes keep samples queued', async () => {
  let release;
  const posts = [];
  globalThis.fetch = (url, opts) => {
    posts.push({ url, body: String(opts.body) });
    return new Promise((resolve) => { release = resolve; });
  };

  for (let i = 0; i < 3; i++) rttReport.recordRttSample(80);
  rttReport.flushSamples();
  const shippedBody = JSON.parse(posts[0].body);
  const queuedAfterFirst = rttReport.pendingSampleCount();

  // More samples arrive while request #1 is still hanging (black-hole link).
  rttReport.recordRttSample(90);
  rttReport.flushSamples(); // must NOT start a second hung fetch
  assert.equal(posts.length, 1, 'one in-flight request at a time');
  assert.equal(rttReport.pendingSampleCount(), queuedAfterFirst + 1,
    'new sample stays queued behind the stall');

  release({ ok: true });
  await new Promise((r) => setTimeout(r, 0));
  rttReport.flushSamples();
  assert.equal(posts.length, 2, 'after the stall settles, shipping resumes');
  assert.deepEqual(JSON.parse(posts[1].body).samples.map((s) => s.rtt), [90],
    'the sample queued during the stall ships intact');
});
