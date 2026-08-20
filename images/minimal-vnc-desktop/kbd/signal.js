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
// Bound stalled WebSocket upgrades without interrupting normal slow connects.
const WS_CONNECT_TIMEOUT_MS = 8000;
const KBD_STALE_MS = 45000;

export function createSignal({ applySignal, applyDialog, applyPopup, kickInput, getInputSock }) {
  let wsBackoff = WS_BACKOFF_MIN;
  let sock = null;
  let signalReconnectTimer = null;
  let dialAt = 0;
  let everOpened = false;
  let lastKbdMsgAt = 0;
  let kbdStaleTimer = null;

  function signalPath() { return siblingPath('/kbd'); }
  function statePath() { return siblingPath('/kbdstate'); }

  // Poll a state snapshot while the keyboard socket is unavailable.
  const BRIDGE_POLL_MS = 600;
  const BRIDGE_GRACE_MS = 1500;
  const BRIDGE_REQ_TIMEOUT_MS = 2500;
  let bridgeTimer = null;
  let bridgeInflight = false;
  let bridgeGen = 0;
  let bridgeSawState = false;
  function stopStateBridge() {
    if (bridgeTimer !== null) { clearTimeout(bridgeTimer); bridgeTimer = null; }
    bridgeGen++;          // invalidate whatever is already in flight
    bridgeInflight = false;
  }
  function socketLive() { return !!sock && sock.readyState === WebSocket.OPEN; }
  function connectWindowMissed() {
    if (!sock) return true;
    if (sock.readyState === WebSocket.OPEN) return false;
    return nowMs() - dialAt >= BRIDGE_GRACE_MS;
  }
  function scheduleBridgePoll() {
    if (bridgeTimer !== null) return;
    bridgeTimer = setTimeout(() => { bridgeTimer = null; pollState(); }, BRIDGE_POLL_MS);
  }
  function pollState() {
    if (socketLive()) { stopStateBridge(); return; }
    if (bridgeInflight) { scheduleBridgePoll(); return; }
    if (!connectWindowMissed()) { scheduleBridgePoll(); return; }
    let url;
    try { url = statePath(); } catch (_) { return; }
    const gen = bridgeGen;
    let ctl = null, abortTimer = null;
    try { ctl = typeof AbortController === 'function' ? new AbortController() : null; } catch (_) { ctl = null; }
    if (ctl) abortTimer = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, BRIDGE_REQ_TIMEOUT_MS);
    bridgeInflight = true;
    const done = () => {
      if (abortTimer !== null) { clearTimeout(abortTimer); abortTimer = null; }
      if (gen !== bridgeGen) return;
      bridgeInflight = false;
      scheduleBridgePoll();
    };
    const opts = { cache: 'no-store' };
    if (ctl) opts.signal = ctl.signal;
    Promise.resolve()
      .then(() => fetch(url, opts))
      .then((r) => (r && r.ok && typeof r.json === 'function' ? r.json() : null))
      .then((d) => {
        if (gen !== bridgeGen) return;
        if (!d) return;
        if (socketLive()) { stopStateBridge(); return; }
        if (d.dialog && applyDialog) applyDialog(d.dialog);
        if (d.popup && applyPopup) applyPopup(d.popup);
        if (d.state) {
          if (!bridgeSawState) { bridgeSawState = true; dbg('kbd state via HTTP bridge (socket still connecting)'); }
          applySignal(d.state);
        }
      })
      .catch(() => {})
      .then(done);
  }
  function startStateBridge() {
    if (bridgeTimer !== null || bridgeInflight) return;
    if (typeof fetch !== 'function') return;
    scheduleBridgePoll();
  }

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
    if (sock && (sock.readyState === WebSocket.CONNECTING || sock.readyState === WebSocket.OPEN)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let s;
    try { s = new WebSocket(proto + '//' + location.host + signalPath()); }
    catch (_) { scheduleReconnect(); return; }
    sock = s;
    dialAt = nowMs();
    dbg('kbd socket connecting');
    // Timer belongs to this socket so stale callbacks cannot affect replacements.
    let myConnectTimer = setTimeout(() => {
      myConnectTimer = null;
      if (sock !== s || s.readyState === WebSocket.OPEN) return;
      dbg('kbd socket connect stalled -> retry');
      try { s.close(); } catch (_) {}   // onclose -> scheduleReconnect
    }, WS_CONNECT_TIMEOUT_MS);
    const clearMyTimer = () => {
      if (myConnectTimer !== null) { clearTimeout(myConnectTimer); myConnectTimer = null; }
    };
    s.onopen = () => {
      clearMyTimer();
      if (sock !== s) { dbg('kbd: late open on a replaced socket -> close'); try { s.close(); } catch (_) {} return; }
      dbg('kbd socket open');
      stopStateBridge(); // the socket is authoritative from here
      everOpened = true;
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
      if (sock !== s) return;
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
      clearMyTimer();
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      // Ignore callbacks from replaced sockets.
      if (sock !== s) { dbg('kbd: stale socket callback ignored'); return; }
      sock = null;
      stopPinging();
      dbg('kbd socket down -> reconnect in ' + wsBackoff + 'ms');
      startStateBridge(); // keep state flowing across the gap
      scheduleReconnect();
    };
    s.onclose = onDown;
    s.onerror = onDown;
  }

  function scheduleReconnect() {
    if (signalReconnectTimer !== null) return; // already pending
    // Hub resends the last state on connect, so we resync automatically.
    signalReconnectTimer = setTimeout(() => { signalReconnectTimer = null; connectSignal(); }, everOpened ? wsBackoff : WS_BACKOFF_MIN);
    if (everOpened) wsBackoff = Math.min(wsBackoff * 2, WS_BACKOFF_MAX);
  }

  // When the OS tells us the network is probably back (or the tab is foreground
  // again), don't sit out the exponential backoff — reset it and reconnect the
  // idle channels immediately. Absolute-state resync on the /kbd hub means an
  // early reconnect is always safe.
  function kickReconnects() {
    dbg('kickReconnects (sock=' + (sock ? 1 : 0) + ' input=' + (getInputSock() ? 1 : 0) + ')');
    wsBackoff = WS_BACKOFF_MIN;
    // Replace only overdue connection attempts.
    if (sock && sock.readyState === WebSocket.CONNECTING &&
        nowMs() - dialAt >= WS_CONNECT_TIMEOUT_MS) {
      dbg('kickReconnects: replacing an overdue connect');
      try { sock.close(); } catch (_) {}
      sock = null;
    }
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

  return {
    connectSignal, kickReconnects, startKbdStaleWatch, sendControl, startStateBridge,
    isOpen: () => !!sock && sock.readyState === WebSocket.OPEN,
  };
}
