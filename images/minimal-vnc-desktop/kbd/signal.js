// signal.js — the /kbd focus-signal WebSocket transport (+ liveness watchdog).
//
// The /kbd hub streams the remote's focus/rect/viewport state to us; this module
// owns only the socket lifecycle — connect, exponential-backoff reconnect, a
// stale-socket reaper, and the network-back kick. Each decoded frame is handed to
// the core's applySignal() (which owns all the state mutation); RTT-echo frames go
// to the ping probe (./rtt.js). The hub resends the last state on connect, so an
// early reconnect always resyncs automatically.
//
// createSignal(deps): applySignal is the core handler; kickInput reconnects the
// native touch channel on a network-back kick; getInputSock is read only for the
// diagnostic log line.

import { MIRROR, nowMs, siblingPath } from './env.js';
import { dbg } from './diag.js';
import { startPinging, handlePong, stopPinging } from './rtt.js';

const WS_BACKOFF_MIN = 500, WS_BACKOFF_MAX = 10000;
const KBD_STALE_MS = 45000;

export function createSignal({ applySignal, applyDialog, applyPopup, kickInput, getInputSock }) {
  let wsBackoff = WS_BACKOFF_MIN;
  let sock = null;
  let signalReconnectTimer = null;
  let lastKbdMsgAt = 0;
  let kbdStaleTimer = null;

  function signalPath() { return siblingPath('/kbd'); }

  // Client-side liveness watchdog for the /kbd viewer socket. Our RTT ping echoes
  // back every 5s and the server pings every 30s, so a healthy pipe stamps
  // lastKbdMsgAt continuously. On a lossy mobile link a half-open socket (wifi<->
  // cell handoff, NAT rebind) can sit readyState=OPEN with NO data for minutes —
  // every focus signal lost, taps hitting stale rects. If nothing arrives for 45s
  // (2x server ping + slack), force-close it; onclose reconnects and the hub
  // resyncs us from lastState. Complements the server-side deadline in main.go.
  function startKbdStaleWatch() {
    if (kbdStaleTimer !== null) return;
    kbdStaleTimer = setInterval(() => {
      if (!sock || sock.readyState !== WebSocket.OPEN) return; // reconnect owns the gap
      if (lastKbdMsgAt && nowMs() - lastKbdMsgAt > KBD_STALE_MS) {
        dbg('kbd socket stale (' + Math.round(nowMs() - lastKbdMsgAt) + 'ms) -> force close');
        try { sock.close(); } catch (_) {} // onclose -> scheduleReconnect -> resync
      }
    }, 15000);
  }

  function connectSignal() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let s;
    try { s = new WebSocket(proto + '//' + location.host + signalPath()); }
    catch (_) { scheduleReconnect(); return; }
    sock = s;
    dbg('kbd socket connecting');
    s.onopen = () => {
      dbg('kbd socket open');
      wsBackoff = WS_BACKOFF_MIN; lastKbdMsgAt = nowMs(); startPinging(s);
      // Opt IN to field-value mirroring. The extension publishes the focused
      // field's text only while some viewer has asked for it, so ?mirror=1 has to
      // (re)assert this on every reconnect — otherwise the mirror seed is empty and
      // iOS autocorrect has no word context. A plain viewer never sends it, and the
      // channel stays structural-only. See keyboard.go setMirror.
      if (MIRROR) {
        try { s.send(JSON.stringify({ mirror: { on: true } })); } catch (_) {}
      }
    };
    s.onmessage = (ev) => {
      lastKbdMsgAt = nowMs(); // any frame (signal, deduped, or RTT echo) = liveness
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg && msg.t === 'ping') { handlePong(msg); return; } // our RTT echo
      // A JS dialog blocking the remote page (see kbd/dialog.js). Its own message
      // shape, not part of the focus state — it comes from the proxy's CDP
      // connection rather than the extension, and must not be fed to applySignal
      // (which would read it as a focus signal with no editable field).
      if (msg && msg.dialog) { if (applyDialog) applyDialog(msg.dialog); return; }
      // A popup window is foreground on the remote (see kbd/popup-bar.js). Its
      // own message shape for the same reason as the dialog: it comes from the
      // proxy's CDP connection, not the extension, so applySignal would read it
      // as a focus signal with no editable field.
      if (msg && msg.popup) { if (applyPopup) applyPopup(msg.popup); return; }
      applySignal(msg);
    };
    const onDown = () => {
      if (sock === s) sock = null;
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      stopPinging();
      dbg('kbd socket down -> reconnect in ' + wsBackoff + 'ms');
      scheduleReconnect();
    };
    s.onclose = onDown;
    s.onerror = onDown;
  }

  function scheduleReconnect() {
    if (signalReconnectTimer !== null) return; // already pending
    // Hub resends the last state on connect, so we resync automatically.
    signalReconnectTimer = setTimeout(() => { signalReconnectTimer = null; connectSignal(); }, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, WS_BACKOFF_MAX);
  }

  // When the OS tells us the network is probably back (or the tab is foreground
  // again), don't sit out the exponential backoff — reset it and reconnect the
  // idle channels immediately. Absolute-state resync on the /kbd hub means an
  // early reconnect is always safe.
  function kickReconnects() {
    dbg('kickReconnects (sock=' + (sock ? 1 : 0) + ' input=' + (getInputSock() ? 1 : 0) + ')');
    wsBackoff = WS_BACKOFF_MIN;
    if (!sock) {
      if (signalReconnectTimer !== null) { clearTimeout(signalReconnectTimer); signalReconnectTimer = null; }
      connectSignal();
    }
    kickInput();
  }

  // Send a small control frame back up the viewer socket. The hub only accepts
  // a dialog reply from a viewer (see keyboard.go) — viewers still cannot
  // broadcast to each other. Dropped silently while the socket is down; the page
  // stays blocked and the user can tap again once it reconnects.
  function sendControl(obj) {
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try { sock.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
  }

  return { connectSignal, kickReconnects, startKbdStaleWatch, sendControl };
}
