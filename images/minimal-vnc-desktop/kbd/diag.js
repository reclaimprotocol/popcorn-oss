// diag.js — keyboard diagnostics (server log + optional on-screen overlay).
//
// dbg(line) records a STRUCTURAL keyboard event — state / type / length / flag
// only, NEVER field text or individual typing events. Aggregate batch lengths
// are logged only where they diagnose IME reconciliation or paste delivery.
//
// BOTH TIERS ARE OFF UNLESS EXPLICITLY ENABLED. Shipping was opt-OUT before,
// which meant every real session streamed a keystroke-by-keystroke trace of
// itself into the pod log — noise in production and a privacy surface that
// nobody had asked for. Opt in per session:
//   ?diag=1 or ?kbdlog=1 (or localStorage pcnKbdLog=1) ship to the proxy's /klog
//   ?kbddebug=1 (or localStorage pcnKbdDebug=1)  on-screen overlay + console,
//                                                and implies kbdlog
// Flags are read once at load, so a session cannot start logging halfway.

import { nowMs, siblingPath } from './env.js';
import { linkLatency } from './latency.js';

function safeLS(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
export const KBD_DEBUG = /[?&]kbddebug=1/.test(location.search) || safeLS('pcnKbdDebug') === '1';
export const KBD_LOG = KBD_DEBUG || /[?&](?:diag|kbdlog)=1/.test(location.search) || safeLS('pcnKbdLog') === '1';

// Per-page-load id so a device's lines group together in the server log.
export const KBD_SID = (Math.floor(Math.random() * 1e9)).toString(36) +
  (Math.floor(nowMs()) % 1000).toString(36);
const klogURL = siblingPath('/klog');
const KLOG_FLUSH_MS = 1500, KLOG_BATCH = 40, KLOG_QUEUE_MAX = 400;
let klogQueue = [];
let klogTimer = null;
let klogDroppedRoutine = 0;

// Diagnostics must never compete with the input stream on a constrained link.
// Keep tap/socket/browser outcomes, but shed repeatable progress lines until the
// connection recovers. navigator.connection is advisory; measured tunnel latency
// is the reliable fallback once the RTT probe has sampled it.
function constrainedLink() {
  try {
    const c = navigator.connection;
    if (c && (c.saveData || c.effectiveType === 'slow-2g' || c.effectiveType === '2g')) return true;
  } catch (_) {}
  return linkLatency() >= 700;
}
function routineLine(line) {
  return line.startsWith('SIG ') || line.startsWith('text send ') ||
    line.startsWith('key send ') || line.startsWith('view resize ') ||
    line.startsWith('canvas ');
}

function klogFlush() {
  if (klogTimer) { clearTimeout(klogTimer); klogTimer = null; }
  if (!KBD_LOG || !klogQueue.length) return;
  const lines = klogQueue;
  klogQueue = [];
  const payload = { sid: KBD_SID, lines: lines };
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
export function dbg(line, essential = false) {
  if (!KBD_LOG) return; // KBD_DEBUG implies KBD_LOG, so this covers both tiers
  // kbddebug explicitly asks for the full overlay; ordinary ?diag=1 remains
  // lossy under link pressure so it cannot worsen the failure being diagnosed.
  if (!KBD_DEBUG && !essential && constrainedLink() && routineLine(line)) {
    klogDroppedRoutine++;
    return;
  }
  if (klogDroppedRoutine) {
    klogEnqueue(Math.round(nowMs()) + ' diag routine-dropped=' + klogDroppedRoutine + ' link=constrained');
    klogDroppedRoutine = 0;
  }
  const entry = Math.round(nowMs()) + ' ' + line;
  klogEnqueue(entry);
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
// Per-keystroke diagnostics are intentionally disabled, including in debug mode.
export function dbgv() {}
// Never let a typed character reach the logs: named keys (Backspace, Enter,
// Arrow*, Unidentified, Process…) pass through; a single printable char is
// redacted so log lines can't reconstruct typed text even in debug mode.
export function safeKeyName(k) { return !k ? '-' : (k.length === 1 ? 'chr' : k); }
// Manual dump: window.__pcnKbdLog() returns the in-memory ring (debug builds).
try { window.__pcnKbdLog = function () { return dbgLog.join('\n'); }; } catch (_) {}
