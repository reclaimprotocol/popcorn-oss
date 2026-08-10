// diag.js — keyboard diagnostics (server log + optional on-screen overlay).
//
// dbg(line) records a STRUCTURAL keyboard event — state / type / length / flag
// only, NEVER field text. Each line is:
//   * shipped (batched) to the proxy's /klog so keyboard issues can be
//     diagnosed straight from SERVER logs, no on-device screenshots needed.
//     ON by default; disable with ?kbdlog=0 or localStorage pcnKbdLog=0.
//   * shown in an on-screen overlay + mirrored to console when ?kbddebug=1
//     (or localStorage pcnKbdDebug=1) — intrusive, so OFF by default.
// dbgv(line) is the VERBOSE tier (per-keystroke / per-move): it only fires when
// the debug flag is on, so it never floods the server in normal operation.

import { nowMs, siblingPath } from './env.js';

function safeLS(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
export const KBD_DEBUG = /[?&]kbddebug=1/.test(location.search) || safeLS('pcnKbdDebug') === '1';
const KBD_LOG = !/[?&]kbdlog=0/.test(location.search) && safeLS('pcnKbdLog') !== '0';

// Per-page-load id so a device's lines group together in the server log.
const KBD_SID = (Math.floor(Math.random() * 1e9)).toString(36) +
  (Math.floor(nowMs()) % 1000).toString(36);
const klogURL = siblingPath('/klog');
const KLOG_FLUSH_MS = 1500, KLOG_BATCH = 40, KLOG_QUEUE_MAX = 400;
let klogQueue = [];
let klogTimer = null;
let klogUAsent = false;

function klogFlush() {
  if (klogTimer) { clearTimeout(klogTimer); klogTimer = null; }
  if (!KBD_LOG || !klogQueue.length) return;
  const lines = klogQueue;
  klogQueue = [];
  const payload = { sid: KBD_SID, lines: lines };
  if (!klogUAsent) { payload.ua = (navigator.userAgent || ''); klogUAsent = true; }
  try {
    const body = JSON.stringify(payload);
    // sendBeacon survives unload and needs no preflight; fetch is the fallback.
    if (navigator.sendBeacon && body.length < 60000) {
      navigator.sendBeacon(klogURL, new Blob([body], { type: 'application/json' }));
    } else if (window.fetch) {
      fetch(klogURL, { method: 'POST', body: body, keepalive: true,
        headers: { 'Content-Type': 'application/json' } }).catch(function () {});
    }
  } catch (_) {}
}
function klogEnqueue(entry) {
  if (!KBD_LOG) return;
  klogQueue.push(entry);
  while (klogQueue.length > KLOG_QUEUE_MAX) klogQueue.shift();
  if (klogQueue.length >= KLOG_BATCH) { klogFlush(); return; }
  if (!klogTimer) klogTimer = setTimeout(klogFlush, KLOG_FLUSH_MS);
}
// Don't lose the tail on navigation / tab-hide.
try {
  window.addEventListener('pagehide', klogFlush);
  window.addEventListener('beforeunload', klogFlush);
  document.addEventListener('visibilitychange', function () { if (document.hidden) klogFlush(); });
} catch (_) {}

let dbgEl = null;
const dbgLog = [];
export function dbg(line) {
  if (!KBD_DEBUG && !KBD_LOG) return;
  const entry = Math.round(nowMs()) + ' ' + line;
  klogEnqueue(entry); // server shipping (default on)
  if (!KBD_DEBUG) return; // overlay + console only when explicitly debugging
  dbgLog.push(entry);
  if (dbgLog.length > 200) dbgLog.shift();
  try { if (window.console) console.log('[kbd] ' + entry); } catch (_) {}
  try {
    if (!dbgEl) {
      dbgEl = document.createElement('div');
      dbgEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'font:11px/1.3 monospace;color:#0f0;background:rgba(0,0,0,.82);padding:4px 6px;' +
        'white-space:pre-wrap;pointer-events:none;max-height:45vh;overflow:hidden;';
      document.body.appendChild(dbgEl);
    }
    dbgEl.textContent = dbgLog.slice(-16).join('\n');
  } catch (_) {}
}
// Verbose (high-frequency) tier — suppressed unless debugging, so per-keystroke
// and per-move lines never flood the server in normal use.
export function dbgv(line) { if (KBD_DEBUG) dbg(line); }
// Never let a typed character reach the logs: named keys (Backspace, Enter,
// Arrow*, Unidentified, Process…) pass through; a single printable char is
// redacted so log lines can't reconstruct typed text even in debug mode.
export function safeKeyName(k) { return !k ? '-' : (k.length === 1 ? 'chr' : k); }
// Manual dump: window.__pcnKbdLog() returns the in-memory ring (debug builds).
try { window.__pcnKbdLog = function () { return dbgLog.join('\n'); }; } catch (_) {}
