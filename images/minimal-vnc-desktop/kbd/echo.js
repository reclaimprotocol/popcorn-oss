// echo.js — optimistic local echo ("unconfirmed" typing pill).
//
// Every keystroke round-trips before its pixels return (1-3s on 3G), and the
// proxy is transparent — so you see NOTHING of your own typing until the remote
// echo arrives. Mirror what you type into a local "unconfirmed" pill ABOVE the
// keyboard, shown instantly, and reconcile it against the remote field length
// (sync.len): when the remote confirms it absorbed what we sent, the pill clears
// (the real pixels have it now). This is the mosh trick.
//
// SECURITY: never render sensitive fields (password / OTP / card). allowed() is
// false for them, so nothing is captured or drawn.
//
// State (echoText / echoComposing / allowed / pill) is fully owned here; the core
// drives it through the returned API. createEcho() takes live accessors for the
// bits it must read from the core (mirror-bar visibility, the keyboard's top edge,
// the RFB-ready flag, and the proxy element for composition preview).

import { nowMs } from './env.js';
import { linkLatency } from './latency.js';

// Local echo only masks LATENCY. On a fast link the remote repaints the typed
// text almost instantly, so the pill is redundant noise; only show it once the
// measured link is slow enough that the echo actually beats the real pixels.
const ECHO_MIN_RTT_MS = 400;

export function stripCtl(s) { return s ? s.replace(/[\x00-\x1f]/g, '') : ''; }

export function createEcho({ getMirrorBarShown, getVisibleBottom, getRfbReady, getProxy }) {
  let echoPill = null;
  let echoText = '';        // committed chars sent but not yet confirmed remotely
  let echoComposing = '';   // live IME composing string (also unconfirmed)
  let echoAllowed = false;  // false on sensitive fields — no capture, no render
  let lastEchoAt = 0;

  function render() {
    // Visible mirror bar is up → it shows the live text natively; the pill would
    // duplicate it. The bar is the echo now.
    if (getMirrorBarShown()) { hidePill(); return; }
    const text = echoText + echoComposing;
    // A disconnect is by definition high-latency — show the echo through the
    // reconnect gap regardless of the measured RTT floor (rttEMA is stale/0 mid-outage).
    if (!text || !echoAllowed || (linkLatency() < ECHO_MIN_RTT_MS && getRfbReady() !== false)) { hidePill(); return; }
    lastEchoAt = nowMs();
    try {
      if (!echoPill) {
        echoPill = document.createElement('div');
        echoPill.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);' +
          'max-width:90vw;box-sizing:border-box;padding:8px 14px;border-radius:10px;' +
          'background:rgba(20,20,20,.92);color:#fff;' +
          'font:500 18px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;' +
          'white-space:pre-wrap;word-break:break-word;pointer-events:none;' +
          'z-index:2147483646;box-shadow:0 2px 12px rgba(0,0,0,.45);' +
          'border-bottom:2px solid #4c8dff;'; // underline = "unconfirmed"
        document.body.appendChild(echoPill);
      }
      echoPill.textContent = text;
      // Match the field's script direction so an RTL echo (Arabic/Hebrew) reads
      // correctly; 'auto' lets the browser bidi-detect when the field set no dir.
      try { const p = getProxy(); echoPill.dir = (p && p.getAttribute && p.getAttribute('dir')) || 'auto'; } catch (_) {}
      const kbTop = getVisibleBottom();
      echoPill.style.top = 'auto';
      echoPill.style.bottom = Math.max(8, window.innerHeight - kbTop + 8) + 'px';
    } catch (_) {}
  }

  function hidePill() {
    if (echoPill) { try { echoPill.remove(); } catch (_) {} echoPill = null; }
  }

  function clear() { echoText = ''; echoComposing = ''; hidePill(); }

  // Locally-typed committed text — append to the unconfirmed echo.
  function append(text) {
    if (!echoAllowed) return;
    const t = stripCtl(text);
    if (!t) return;
    echoText += t;
    render();
  }

  // Backspace — drop the last n grapheme-ish code points from the echo.
  function backspace(n) {
    if (!echoAllowed || !echoText) return;
    const arr = Array.from(echoText); // codepoint-aware (don't split emoji)
    arr.splice(Math.max(0, arr.length - (n || 1)));
    echoText = arr.join('');
    render();
  }

  // The remote confirmed it absorbed `confirmed` leading chars of our echo →
  // drop that prefix so the pill tightens to just the still-in-flight tail.
  // Called with no arg (or a count >= the echo length) it clears everything —
  // the full-catch-up / safety-net terminal case. Keeps any live composing string.
  function reconcile(confirmed) {
    if (!echoText) return;
    const arr = Array.from(echoText); // codepoint-aware (don't split emoji)
    const n = (confirmed == null) ? arr.length
                                  : Math.max(0, Math.min(confirmed, arr.length));
    if (n <= 0) return;
    arr.splice(0, n);
    echoText = arr.join('');
    render();
  }

  // <input>-path composition preview (iOS + Android hidden-input). e.data is the
  // current marked text; fall back to proxy.value.
  function onCompositionUpdate(e) {
    const proxy = getProxy();
    echoComposing = stripCtl((e && e.data) || (proxy && proxy.value) || '');
    render();
  }

  return {
    render, hidePill, clear, append, backspace, reconcile, onCompositionUpdate, stripCtl,
    setComposing(v) { echoComposing = v; },
    setAllowed(v) { echoAllowed = v; },
    allowed() { return echoAllowed; },
    textLen() { return echoText ? Array.from(echoText).length : 0; },
    hasText() { return !!echoText; },
    lastAt() { return lastEchoAt; },
  };
}
