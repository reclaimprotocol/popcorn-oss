// watchdog.js — stuck-keyboard watchdog.
//
// If a dismiss signal is ever lost (e.g. the extension worker died as the
// field blurred), keyboardActive can wedge "up". A cheap 1s check catches it:
// keyboard marked active but the proxy no longer holds focus for ~1.5s means
// the OS keyboard is really gone — force a clean dismiss.
//
// createWatchdog(deps) closes over live accessors for the core flags it polls
// and the dismiss callback it fires. Owns only its own timer/miss-count state.

import { dbg } from './diag.js';

export function createWatchdog({
  getKeyboardActive, getKeyboardOpening, getKeyboardJustDismissed, getProxy, dismissKeyboard,
}) {
  let watchdogTimer = null;
  let watchdogMiss = 0;

  function start() {
    if (watchdogTimer !== null) return;
    watchdogMiss = 0;
    watchdogTimer = setInterval(() => {
      // Self-stop once inactive (covers dismiss paths that set the flag
      // directly — onProxyBlur, viewport-grow — without calling dismissKeyboard).
      if (!getKeyboardActive()) { stop(); return; }
      if (getKeyboardOpening() || getKeyboardJustDismissed()) { watchdogMiss = 0; return; }
      if (document.activeElement === getProxy()) { watchdogMiss = 0; return; }
      if (++watchdogMiss >= 2) { watchdogMiss = 0; dbg('watchdog: proxy lost focus -> dismiss'); dismissKeyboard(); }
    }, 1000);
  }

  function stop() {
    if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
    watchdogMiss = 0;
  }

  return { start, stop };
}
