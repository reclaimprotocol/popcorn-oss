// rtt.js — /kbd tunnel round-trip probe.
//
// The server echoes a {"t":"ping"} frame straight back, so a small periodic ping
// measures live tunnel round-trip time. That seeds the adaptive dismiss/recovery
// windows BEFORE the first tap (they'd otherwise be blind at the 1500ms default on
// a slow link) and doubles as a NAT keep-alive. Measured round-trips are folded
// into the shared latency EMA (./latency.js).
//
// Owns only its own timer/sequence state; the caller drives it from the /kbd
// socket lifecycle: startPinging(sock) on open, handlePong(msg) on each echo,
// stopPinging() on close.

import { nowMs } from './env.js';
import { noteRtt } from './latency.js';

const PING_INTERVAL_MS = 5000;
let pingSeq = 0;
let pingTimer = null;
const pendingPings = new Map(); // id -> sent time

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
  send();
  pingTimer = setInterval(send, PING_INTERVAL_MS);
}

export function handlePong(msg) {
  const sentAt = pendingPings.get(msg.id);
  if (sentAt == null) return;
  pendingPings.delete(msg.id);
  const rtt = nowMs() - sentAt;
  if (rtt >= 0 && rtt < 20000) noteRtt(rtt);
}
