// rtt.js — /kbd tunnel round-trip probe.
//
// The server echoes a {"t":"ping"} frame straight back, so a small periodic ping
// measures live tunnel round-trip time. That seeds the adaptive dismiss/recovery
// windows BEFORE the first tap (they'd otherwise be blind at the 1500ms default on
// a slow link) and doubles as a NAT keep-alive. Measured round-trips are folded
// into the shared latency EMA (./latency.js) and recorded as raw history for
// analytics shipping (./rtt-report.js).
//
// SAMPLING IS JITTERED PER SESSION. A fixed cadence would synchronize every
// viewer's probes against the same wall clock (page loads cluster, so samples
// correlate and aggregate graphs pulse). Instead each session draws its own
// inter-ping delay uniformly from [PING_MIN_MS, PING_MAX_MS] after every send —
// a renewal process with the same ~5s mean as the old fixed timer, but
// decorrelated across sessions. The scheduling runs on a coarse interval grid
// rather than self-rescheduling timeouts so an idle tab pays one cheap wake
// per second, not a timer churn per ping.
//
// Owns only its own timer/sequence state; the caller drives it from the /kbd
// socket lifecycle: startPinging(sock) on open, handlePong(msg) on each echo,
// stopPinging() on close.

import { nowMs } from './env.js';
import { noteRtt } from './latency.js';
import { recordRttSample } from './rtt-report.js';

const PING_TICK_MS = 1000;
const PING_MIN_MS = 2000;
const PING_MAX_MS = 8000;

let pingSeq = 0;
let pingTimer = null;
let lastRtt = null; // latest measured round trip (ms); null until the first pong
let rttCount = 0;   // pongs measured this page
let lastSentAt = 0;
let nextDelayMs = 0;
const pendingPings = new Map(); // id -> sent time

// Per-send renewal draw. Uniform integers; mean (MIN+MAX)/2 = 5000ms matches the
// historic fixed cadence, so downstream expectations about sample density hold.
function drawInterval() {
  return PING_MIN_MS + Math.floor(Math.random() * (PING_MAX_MS - PING_MIN_MS + 1));
}

export function stopPinging() {
  if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
  pendingPings.clear();
}

export function startPinging(s) {
  stopPinging();
  const send = () => {
    if (s.readyState !== WebSocket.OPEN) return;
    const id = ++pingSeq;
    pendingPings.set(id, nowMs());
    if (pendingPings.size > 8) pendingPings.delete(pendingPings.keys().next().value);
    try { s.send(JSON.stringify({ t: 'ping', id })); } catch (_) {}
  };
  send(); // first sample immediately, like always — it seeds the EMA earliest
  lastSentAt = nowMs();
  nextDelayMs = drawInterval();
  const tick = () => {
    const t = nowMs();
    if (t - lastSentAt < nextDelayMs) return;
    if (s.readyState !== WebSocket.OPEN) { lastSentAt = t; return; }
    send();
    lastSentAt = t;
    nextDelayMs = drawInterval();
  };
  pingTimer = setInterval(tick, PING_TICK_MS);
}

export function handlePong(msg) {
  const sentAt = pendingPings.get(msg.id);
  if (sentAt == null) return;
  pendingPings.delete(msg.id);
  const rtt = nowMs() - sentAt;
  if (rtt >= 0 && rtt < 20000) {
    lastRtt = Math.round(rtt);
    rttCount += 1;
    noteRtt(rtt);
    recordRttSample(lastRtt);
  }
}

// Read by the host bridge to answer POPCORN_RTT_REQUEST.
export function lastRttMs() { return lastRtt; }
export function rttSampleCount() { return rttCount; }
