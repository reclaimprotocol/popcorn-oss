// fbscale.js — optional framebuffer supersampling for device A/B testing.
// `1` is the safe default; `auto` and `2|3` are explicit opt-ins.

import { MAGNIFY, isTouch } from './env.js';
import { dbg } from './diag.js';
import { linkRtt } from './latency.js';

// Above this measured tunnel RTT, more pixels per frame is the wrong trade: bytes
// per frame is already what gates responsiveness (the same threshold quality.js
// uses to START shedding quality, so the two levers cannot fight — we stop adding
// pixels before it starts removing them).
const HEALTHY_RTT_MS = 400;
// Devices below this gain nothing: their CSS pixel IS roughly their device pixel.
const MIN_DPR = 2;
// Hard ceiling on the factor. k=3 on a 3x phone is 9x the pixels; available for a
// measurement run, never chosen by the policy.
const MAX_SCALE = 3;
const AUTO_SCALE = 2;
// How often the policy is re-evaluated. Slow on purpose: each change is a
// framebuffer reallocation and a CDP re-emulate, so flapping would be worse than
// either steady state.
const WATCH_MS = 2000;
// Don't step up until the link has been healthy for this long. One lucky RTT sample
// during a page load is not a healthy link.
const SETTLE_MS = 3000;

export const FBSCALE_MODE = (function () {
  try {
    const raw = new URLSearchParams(location.search).get('fbscale');
    // Supersampling multiplies both encode work and wire bytes.  RTT only tells
    // us the control path is healthy; it cannot see pod encode saturation or a
    // slow mobile compositor.  Keep the latency-sensitive login path at its
    // established 1x behaviour unless an integrator explicitly asks to A/B it.
    if (raw === null) return 1;
    if (raw === 'auto') return 'auto';
    const n = parseInt(raw, 10);
    if (!isFinite(n) || n < 1) return 1;
    return Math.min(MAX_SCALE, n);
  } catch (_) { return 'auto'; }
})();

function dpr() {
  try { return window.devicePixelRatio || 1; } catch (_) { return 1; }
}

// Is the link in a state where spending k^2 pixels is defensible? navigator
// .connection is advisory and often absent; the measured tunnel RTT is the signal
// that is always available once the RTT probe has a sample, and 0 means "no sample
// yet" — which is NOT healthy, it is unknown, and unknown must stay at 1x.
function linkHealthy() {
  try {
    const c = navigator.connection;
    if (c) {
      if (c.saveData) return false;
      if (/^(slow-2g|2g|3g)$/.test(String(c.effectiveType))) return false;
    }
  } catch (_) {}
  const rtt = linkRtt();
  return rtt > 0 && rtt < HEALTHY_RTT_MS;
}

// Is the framebuffer already smaller than the window it is being shown in? That is
// the kiosk-screen cap biting (viewer.js __pcnFbTarget), i.e. a window larger than
// the remote screen — a desktop shape, where the stream is already being upscaled
// from a cap-limited render and more pixels are not available to ask for. Always
// false on a phone, whose viewport is far inside the cap.
function capLimited() {
  try {
    const t = window.__pcnFbTarget && window.__pcnFbTarget(window.innerWidth, window.innerHeight);
    if (!t) return false;
    return t.cssW < window.innerWidth || t.cssH < window.innerHeight;
  } catch (_) { return false; }
}

/**
 * The factor the policy wants right now, before the framebuffer ceiling is applied
 * (viewer.js __pcnFbTarget clamps the product to FB_MAX). Fit state is read from the
 * flag fit.js already publishes, so this module needs no wiring into it.
 */
export function wantedScale() {
  if (FBSCALE_MODE !== 'auto') return FBSCALE_MODE;
  if (!MAGNIFY || !isTouch) return 1;
  if (dpr() < MIN_DPR) return 1;
  try {
    if (window.__pcnFitActive) return 1; // a desktop-fit page is already supersampled
  } catch (_) {}
  if (capLimited()) return 1;
  if (!linkHealthy()) return 1;
  return AUTO_SCALE;
}

/**
 * Watch the policy and report changes. The caller owns what a change DOES (see
 * fit.applyFbScale) — this module only decides, so the decision is testable
 * without a framebuffer.
 *
 * `getBlocked` lets the caller veto a change at a moment when resizing the
 * framebuffer would fight something else (mid-zoom, mid-fit-dance).
 */
export function createFbScaleWatch({ onChange, getBlocked, getCurrent }) {
  let timer = null;
  let healthySince = 0;

  function evaluate() {
    const current = getCurrent();
    let want = wantedScale();
    // A PINNED factor is a one-shot decision, so stop watching once it has landed
    // — but only then. Stopping at the first evaluation (which is what "apply it
    // once and stop" used to mean) dropped the factor whenever that evaluation
    // happened to land in the blocked window at boot, which is where it always
    // lands: the watcher starts inside setup(), a few ms before the RFB connection
    // is ready, and !rfbReady is a block. ?fbscale=N then did nothing for the whole
    // session, silently.
    if (FBSCALE_MODE !== 'auto' && current === want) { stop(); return; }
    // Stepping UP is the expensive direction, so it waits for a sustained healthy
    // link; stepping DOWN is relief and happens immediately. The settle window is
    // a property of the AUTO policy — a pinned ?fbscale=N is a measurement run
    // that has already said it does not care about link health, and making it wait
    // out a settle it can never observe is how the flag ends up looking inert.
    if (FBSCALE_MODE === 'auto' && want > current) {
      const now = Date.now();
      if (!healthySince) healthySince = now;
      if (now - healthySince < SETTLE_MS) return;
    } else {
      healthySince = 0;
    }
    if (want === current) return;
    if (getBlocked && getBlocked()) return;
    dbg('fbscale ' + current + ' -> ' + want + ' (dpr=' + dpr().toFixed(2) +
      ' rtt=' + Math.round(linkRtt()) + 'ms mode=' + FBSCALE_MODE + ')', true);
    onChange(want);
  }

  function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }

  return {
    start() {
      if (timer !== null) return;
      // Poll in BOTH modes. Auto re-decides forever; pinned re-tries until the
      // factor is actually applied and then stops itself (see evaluate()), so a
      // pinned session costs one comparison every WATCH_MS until it lands and
      // nothing after that.
      timer = setInterval(evaluate, WATCH_MS);
      evaluate();
    },
    stop,
    evaluate,
  };
}
