// watchdog.js — dismiss a stale keyboard without fighting a competing focus.

import { dbg } from './diag.js';

export function createWatchdog({
  getKeyboardActive, getKeyboardOpening, getKeyboardJustDismissed, getProxy, dismissKeyboard,
  getKeyboardOccluded, reclaimFocus, onFocusStolen,
}) {
  let watchdogTimer = null;
  let watchdogMiss = 0;
  // hasFocus() is absent in some embedded webviews; treat "cannot tell" as "fine"
  // so a missing API can never manufacture a report.
  function documentBlurred() {
    try { return typeof document.hasFocus === 'function' && document.hasFocus() === false; } catch (_) { return false; }
  }
  let reclaims = 0;         // reclaim attempts for the CURRENT focus loss
  // A page that fights us for the focus would otherwise get an endless tug-of-war
  // at 1Hz. Two attempts is enough to ride out a one-off steal (a banner mounting,
  // a scroll-into-view); past that the honest answer is to let the keyboard go.
  const MAX_RECLAIMS = 2;

  function start() {
    if (watchdogTimer !== null) return;
    watchdogMiss = 0;
    reclaims = 0;
    watchdogTimer = setInterval(() => {
      // Self-stop once inactive (covers dismiss paths that set the flag
      // directly — onProxyBlur, viewport-grow — without calling dismissKeyboard).
      if (!getKeyboardActive()) { stop(); return; }
      if (getKeyboardOpening() || getKeyboardJustDismissed()) { watchdogMiss = 0; return; }
      const proxy = getProxy();
      const active = document.activeElement;
      if (active === proxy) {
        watchdogMiss = 0; reclaims = 0;
        // Our element still holds the focus WITHIN this document, but the document
        // itself does not have it: something in the embedding page took it, and the
        // keyboard is closing (or closed) with no local signal at all.
        if (documentBlurred() && onFocusStolen) { try { onFocusStolen(); } catch (_) {} }
        return;
      }
      // Focus is gone. Was it TAKEN (another element holds it) or dropped?
      const stolen = !!active && active !== document.body && active.tagName !== 'HTML';
      if (stolen && reclaimFocus && reclaims < MAX_RECLAIMS) {
        reclaims++;
        dbg('watchdog: proxy lost focus -> reclaim #' + reclaims);
        try { reclaimFocus(); } catch (_) {}
        if (document.activeElement === proxy) {
          // It came back synchronously: nobody had taken the keyboard away, the
          // focus had merely been moved. Report it — an embedder stealing focus
          // from a live keyboard is an integration bug it cannot see otherwise.
          watchdogMiss = 0;
          if (onFocusStolen) { try { onFocusStolen(); } catch (_) {} }
          return;
        }
        // Give the reclaim one tick to land asynchronously before counting a miss.
        return;
      }
      // Never tear down while the keys are still visibly occluding — Android can
      // move focus off the proxy with the IME up. after iframe embed
      if (getKeyboardOccluded && getKeyboardOccluded()) { watchdogMiss = 0; return; }
      if (++watchdogMiss >= 2) { watchdogMiss = 0; dbg('watchdog: proxy lost focus -> dismiss'); dismissKeyboard(); }
    }, 1000);
  }

  function stop() {
    if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
    watchdogMiss = 0;
    reclaims = 0;
  }

  return { start, stop };
}
