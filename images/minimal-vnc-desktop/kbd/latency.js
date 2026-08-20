// latency.js — the two link-latency EMAs and the windows derived from them.
//
// A cross-cutting concern: the adaptive dismiss/recovery windows, the touchmove
// throttle, the local-echo gate, and the typing-quality downgrade all size
// themselves off the measured link latency. Two independent samples feed it:
//   * tap -> editable-confirm  (learned after the first tap; includes remote
//     processing) — fed via noteTapConfirm() from the /kbd signal handler.
//   * /kbd tunnel round-trip   (available from the first ping) — fed via
//     noteRtt() from the RTT probe (./rtt.js).
// linkLatency() is the max of the two; dismissDelay() scales the dismiss window.
//
// State lives in this module and is read only through the exported getters, so
// every consumer sees the same live value with no shared-mutable plumbing.

export const DISMISS_MIN_MS = 1000;
export const DISMISS_MAX_MS = 5000;
export const DISMISS_BASE_MS = 1500;

let emaLatency = 0; // learned tap -> editable-confirm latency
let rttEMA = 0;     // measured /kbd tunnel round-trip (see ./rtt.js ping/pong)

// Larger of the two estimates: tap->confirm is only learned after the first tap,
// the /kbd RTT is available from the first ping — so the window is adaptive from
// the start and never underestimates a slow link. 0 until the first sample.
export function linkLatency() { return Math.max(emaLatency, rttEMA); }

// Network RTT without remote-processing time.
export function linkRtt() { return rttEMA; }

export function dismissDelay() {
  const latency = linkLatency();
  if (latency <= 0) return DISMISS_BASE_MS;
  return Math.max(DISMISS_MIN_MS, Math.min(DISMISS_MAX_MS, latency * 2.5 + 400));
}

// Learn a tap -> editable-confirm observation (ms). Callers pre-filter to a sane
// range; this only folds the sample into the EMA.
export function noteTapConfirm(observed) {
  emaLatency = emaLatency > 0 ? emaLatency * 0.7 + observed * 0.3 : observed;
}

// Fold a measured /kbd round-trip (ms) into the RTT EMA.
export function noteRtt(rtt) {
  rttEMA = rttEMA > 0 ? rttEMA * 0.7 + rtt * 0.3 : rtt;
}
