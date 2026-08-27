// watchdog.js — dismiss a stale keyboard without fighting a competing focus.

import { dbg } from './diag.js';

export function createWatchdog({
  getKeyboardActive, getKeyboardOpening, getKeyboardJustDismissed, getProxy, dismissKeyboard,
  reclaimFocus, onFocusStolen, keyboardOccluding,
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
      // A DROPPED focus is not evidence the keyboard went away. On an embedded
      // Android WebView the focus can land back on the body while the IME stays
      // up, and the authoritative geometry keeps reporting the occlusion. Treating
      // that as "gone" produced a ~3s loop in a real session — "host geom occ=342
      // -> kbd=true" then "proxy lost focus -> dismiss", five times over — with
      // the user unable to type into the field they had tapped. When something
      // that CAN see the keyboard still says it occludes, ask for the focus back
      // instead; MAX_RECLAIMS still ends a keyboard that really did go away.
      const occluding = !stolen && typeof keyboardOccluding === 'function' && keyboardOccluding();
      if ((stolen || occluding) && reclaimFocus && reclaims < MAX_RECLAIMS) {
        reclaims++;
        dbg('watchdog: proxy lost focus (' + (stolen ? 'stolen' : 'dropped, still occluding')
          + ') -> reclaim #' + reclaims);
        try { reclaimFocus(); } catch (_) {}
        if (document.activeElement === proxy) {
          // It came back synchronously: nobody had taken the keyboard away, the
          // focus had merely been moved. Report it only when another element
          // actually held it — an embedder stealing focus from a live keyboard is
          // an integration bug it cannot see otherwise. A dropped focus we simply
          // picked back up is not that, and reporting it would cry wolf.
          watchdogMiss = 0;
          // Spend the budget only on a CONTESTED focus. Against a page that keeps
          // taking it, MAX_RECLAIMS is what stops a 1Hz tug-of-war, so successive
          // steals keep counting. A dropped focus has no opponent: the reclaim
          // landed, the user can type again, and the next drop is a fresh event —
          // charging it to the same budget is what let a WebView that drops focus
          // every second exhaust the attempts and dismiss a keyboard that was
          // still on screen.
          if (!stolen) reclaims = 0;
          if (stolen && onFocusStolen) { try { onFocusStolen(); } catch (_) {} }
          return;
        }
        // Give the reclaim one tick to land asynchronously before counting a miss.
        return;
      }
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
