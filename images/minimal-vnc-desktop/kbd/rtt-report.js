// rtt-report.js — raw RTT sample history + batched shipping to the proxy.
//
// The EMA in ./latency.js keeps the ADAPTIVE state (one live number); this
// module keeps the HISTORY: raw {at, rtt} pairs from the ping probe, batched
// and POSTed to the proxy's /rtstats endpoint so per-session link quality
// reaches analytics instead of dying with the page. Payload is structural
// telemetry only — millisecond integers and elapsed offsets. No field text,
// no page content, no URLs.
//
// Shipping mirrors diag.js's /klog discipline: sendBeacon when available
// (survives unload), fetch as fallback, bounded queue so a black hole endpoint
// cannot grow memory. The session id is parsed from the gateway path
// (/liveview/<session>/<token>/...) when present — the proxy only sees its
// internal path, so this is what lets one pod serve many sessions without
// server-side URL rewriting.
//
// CONSTRAINED-LINK DISCIPLINE (same rule as diag.js): telemetry must never
// compete with the input stream for airtime while a session is actively
// struggling. The periodic timer flush stands down on a constrained link —
// samples stay queued in the ring (which holds ~20min) and ride out with the
// pagehide beacon or a later healthy-window tick. Measuring a bad link must
// not make the bad link worse. The fetch path additionally refuses to stack
// requests behind one that has not settled: on a half-open connection each
// hung POST would otherwise pin one of the browser's few per-host sockets.

import { nowMs, siblingPath } from './env.js';
import { linkLatency } from './latency.js';

const SAMPLE_MAX = 256;   // ring bound: ~20min of pings at the 5s mean
const FLUSH_BATCH_MAX = 128;
const FLUSH_MS = 30000;
// One-shot early flush after the first sample: sessions are routinely killed
// within seconds, and at the 30s cadence they'd die with every sample still
// client-side — the teardown readers can only see what reached the proxy.
const EARLY_FLUSH_MS = 3000;
const CONSTRAINED_MS = 700; // matches diag.js's shedding threshold

function rttPath() {
  try { return siblingPath('/rtstats'); } catch (_) { return '/rtstats'; }
}

function constrainedLink() {
  if (linkLatency() >= CONSTRAINED_MS) return true;
  try {
    const c = navigator.connection;
    if (c && (c.saveData || c.effectiveType === 'slow-2g' || c.effectiveType === '2g')) return true;
  } catch (_) {}
  return false;
}

// Session correlation. Absent on non-gateway hosts (local harnesses, embeds) —
// callers treat null as "aggregate by connection instead".
export function sessionIdFromPath() {
  try {
    const m = /\/liveview\/([^/]+)\//.exec(location.pathname);
    return m ? m[1].slice(0, 64) : null;
  } catch (_) { return null; }
}

let samples = []; // [{at, rtt}] — at is ABSOLUTE (performance.now ms)
let flushTimer = null;
let earlyFlushArmed = false;
let fetchInFlight = false;

function ensureFlushTimer() {
  if (flushTimer !== null || typeof setInterval !== 'function') return;
  flushTimer = setInterval(function () {
    if (constrainedLink()) return; // shed now; pagehide still beacons the ring
    flushSamples();
  }, FLUSH_MS);
}

// Returns true if the payload was handed to the platform (beacon queued / fetch
// started). A false return means "not shipped" so the caller can keep the data.
function post(payload) {
  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon && body.length < 60000) {
      if (navigator.sendBeacon(rttPath(), new Blob([body], { type: 'application/json' }))) return true;
    }
  } catch (_) {}
  if (!window.fetch || fetchInFlight) return false;
  fetchInFlight = true;
  window.fetch(rttPath(), {
    method: 'POST', body, keepalive: true,
    headers: { 'Content-Type': 'application/json' },
  }).catch(function () {}).then(function () { fetchInFlight = false; });
  return true;
}

// Ship the oldest samples, oldest-first, capped per batch. Samples are only
// dropped from the queue once actually handed off; anything not shipped stays
// queued (the ring bound already caps how far behind a dead endpoint can fall).
export function flushSamples() {
  if (!samples.length) return;
  const batch = samples.slice(0, FLUSH_BATCH_MAX);
  const t0 = batch[0].at;
  const shipped = post({
    sid: sessionIdFromPath(),
    t0: Math.round(t0),
    // Offsets, not absolute stamps: small payloads, no wall clock leaked.
    samples: batch.map((s) => ({ at: Math.round(s.at - t0), rtt: s.rtt })),
  });
  if (shipped) samples.splice(0, batch.length);
}

export function recordRttSample(rtt) {
  if (!(rtt >= 0 && rtt < 20000)) return;
  ensureFlushTimer();
  if (!earlyFlushArmed && typeof setTimeout === 'function') {
    earlyFlushArmed = true;
    setTimeout(function () {
      if (constrainedLink()) return; // same shedding rule as the periodic timer
      flushSamples();
    }, EARLY_FLUSH_MS);
  }
  samples.push({ at: nowMs(), rtt: Math.round(rtt) });
  while (samples.length > SAMPLE_MAX) samples.shift();
  // Batch-full flush is unconditional (it fires ~once per 10 minutes of pings,
  // so it costs nothing even mid-struggle); only the TIMER flush sheds.
  if (samples.length >= FLUSH_BATCH_MAX) flushSamples();
}

// Test/observability read of the unsent queue.
export function pendingSampleCount() { return samples.length; }

try {
  window.addEventListener('pagehide', flushSamples);
  window.addEventListener('beforeunload', flushSamples);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flushSamples(); });
} catch (_) {}
