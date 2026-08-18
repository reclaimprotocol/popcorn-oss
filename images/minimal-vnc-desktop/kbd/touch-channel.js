// touch-channel.js — the native /input WebSocket + touch-point mapping/coalescing.
//
// We stream real touch points to the proxy's /input WS, which dispatches CDP
// Input.dispatchTouchEvent so the REMOTE page handles scroll/drag/sliders/pinch
// itself (VNC only carries mouse). The viewer's gesture handlers (onTouchStart/
// Move/End, in the core) own gesture CLASSIFICATION and call in here to map and
// send points; this module owns the socket, the screen→remote mapping, and the
// RTT-adaptive touchmove coalescing. Reconnects itself on drop.
//
// createTouchChannel(deps) closes over live accessors for the bits it reads from
// the core (the #screen element, the remote viewport, whether a remote touch is
// active) plus a callback to stamp the last remote-scroll time.

import { MAGNIFY, TOUCH_INPUT, nowMs, siblingPath } from './env.js';
import { dbg, dbgv, KBD_LOG, KBD_SID } from './diag.js';
import { linkRtt } from './latency.js';
import { formatPoint, formatPoints } from './diag-geometry.js';

// Coalesce touchmove sends. A fast swipe fires touchmove 60-120x/s; forwarding
// each one floods /input -> CDP -> a burst of tiny scroll frames over the tunnel
// (the jitter). We keep only the LATEST position per interval. The interval is
// RTT-ADAPTIVE — see moveIntervalMs.
const MOVE_INTERVAL_FULL_MS = 16;   // ~60fps on a very healthy link (<150ms RTT):
                                    // the forwarded scroll/drag is smoothest when
                                    // the remote gets moves at display rate; the
                                    // extra packets are affordable only when the
                                    // uplink clearly isn't the bottleneck.
const MOVE_INTERVAL_FAST_MS = 33;   // ~30fps on a healthy link
const MOVE_INTERVAL_SLOW_MS = 100;  // ~10fps floor on a genuinely slow link:
                                    // enough to keep a drag/scroll feeling like
                                    // motion (not stepping) while still cutting
                                    // the packet flood that stalls touchEnd

export function createTouchChannel({ getRfb, getScreenElement, getViewport, getRemoteTouchActive, noteRemoteScroll }) {
  let inputSock = null;
  let inputReconnectTimer = null;
  let gestureSent = 0;
  let gestureDropped = 0;
  let gestureCoalesced = 0;
  let gestureStartPoints = '[]';
  let gestureID = 0;

  function finishGesture(type) {
    dbg('touch g#' + gestureID + ' ' + type + ' start=' + gestureStartPoints + ' sent=' + gestureSent +
      ' dropped=' + gestureDropped + ' coalesced=' + gestureCoalesced +
      ' socket=' + (inputSock && inputSock.readyState === WebSocket.OPEN ? 'open' : 'down'));
  }

  // A REAL click, over VNC rather than CDP.
  //
  // This is the same path a desktop mouse takes: an RFB PointerEvent reaches Xvnc
  // and moves the actual X pointer, so Chromium sees an OS-level click with no
  // synthesis anywhere. It is the one input method reCAPTCHA was observed to accept,
  // and it sidesteps the CDP question entirely — whether a touch becomes a click in
  // a given out-of-process iframe is Chrome's business, and here we never ask.
  //
  // Used ONLY for taps the caller has already decided need a mouse click (inside a
  // cross-origin frame). Everything else keeps going out as real touch on /input:
  // a pointer event is a MOUSE, so a page bound only to touch handlers would see
  // nothing, and a "touch device" (maxTouchPoints 5, pointer: coarse) that emits
  // none is its own fingerprint tell.
  //
  // Coordinates are canvas-relative CSS px — Display.absX/absY divide by noVNC's
  // own scale to reach framebuffer px. The rect is measured through OUR CSS zoom
  // transform (noVNC's clientToElement does not compensate for one, which is why
  // its rect-based math must not see it), so undo the zoom with clientWidth/rect
  // width before handing the point over.
  //
  // _handleMouseButton is private API. Guarded, with the /input click as fallback:
  // a noVNC upgrade that renames it degrades to the CDP path instead of silently
  // dropping every tap inside an iframe.
  function sendPointerClick(sx, sy) {
    const rfb = getRfb ? getRfb() : null;
    if (!rfb || typeof rfb._handleMouseButton !== 'function') return false;
    const screen = getScreenElement();
    const canvas = screen ? screen.querySelector('canvas') : null;
    if (!canvas) return false;
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return false;
    // clientWidth is the UNtransformed layout width, cr.width the transformed one,
    // so their ratio undoes our CSS zoom. Guarded: a canvas not yet laid out reports
    // 0, and an unguarded divide would send NaN coordinates (which RFB encodes as
    // garbage rather than rejecting).
    const zx = canvas.clientWidth > 0 ? canvas.clientWidth / cr.width : 1;
    const zy = canvas.clientHeight > 0 ? canvas.clientHeight / cr.height : 1;
    const ex = (sx - cr.left) * zx;
    const ey = (sy - cr.top) * zy;
    if (!isFinite(ex) || !isFinite(ey)) return false;
    try {
      // move -> press -> release, the shape of a human click. The bare move first
      // also lets hover-dependent widgets settle before the button goes down.
      rfb.__pcnPointerCoordsAreLayout = true;
      rfb._handleMouseButton(ex, ey, 0);
      rfb._handleMouseButton(ex, ey, 1);
      rfb._handleMouseButton(ex, ey, 0);
    } catch (_) { return false; }
    finally { rfb.__pcnPointerCoordsAreLayout = false; }
    dbg('x11 click screen=' + formatPoint(sx, sy) + ' layout=' + formatPoint(ex, ey));
    return true;
  }

  function inputPath() { return siblingPath('/input'); }
  // Bound stalled input upgrades.
  const INPUT_CONNECT_TIMEOUT_MS = 8000;
  let inputAttempt = 0;
  let inputDialAt = 0;
  function scheduleInputReconnect() {
    if (inputReconnectTimer !== null) return;
    inputReconnectTimer = setTimeout(() => { inputReconnectTimer = null; connectInput(); }, 1000);
  }
  function connectInput() {
    // Physical mouse clicks in magnify use this channel too. It maps them in
    // remote CSS pixels (the same coordinate space as verified touch input),
    // avoiding noVNC's transform-blind mouse conversion.
    if (!MAGNIFY) return;
    // Do not replace a live or in-flight connection.
    if (inputSock && (inputSock.readyState === WebSocket.CONNECTING ||
                      inputSock.readyState === WebSocket.OPEN)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let s;
    try { s = new WebSocket(proto + '//' + location.host + inputPath()); }
    catch (_) { scheduleInputReconnect(); return; }
    inputSock = s;
    inputAttempt++;
    inputDialAt = nowMs();
    const myAttempt = inputAttempt, myDialAt = inputDialAt;
    dbg('input socket connecting #' + myAttempt);
    // Keep the watchdog local to this connection.
    let myConnectTimer = setTimeout(() => {
      myConnectTimer = null;
      if (inputSock !== s || s.readyState === WebSocket.OPEN) return;
      dbg('input socket connect stalled -> retry');
      try { s.close(); } catch (_) {}   // onclose -> scheduleInputReconnect
    }, INPUT_CONNECT_TIMEOUT_MS);
    const clearMyTimer = () => {
      if (myConnectTimer !== null) { clearTimeout(myConnectTimer); myConnectTimer = null; }
    };
    s.onopen = () => {
      clearMyTimer();
      if (inputSock !== s) { dbg('input: late open on a replaced socket -> close'); try { s.close(); } catch (_) {} return; }
      dbg('input socket open #' + myAttempt + ' upgrade=' + Math.round(nowMs() - myDialAt) + 'ms');
    };
    s.onmessage = (e) => {
      // Terminal input acknowledgements prove the proxy queued, then wrote, the
      // matching CDP command. They contain only the random diagnostics SID and
      // gesture number — no coordinates or page/input contents.
      if (!KBD_LOG) return;
      try {
        const a = JSON.parse(e.data);
        if (a && a.diag === 'input' && a.sid === KBD_SID && typeof a.g === 'number') {
          dbg('input g#' + a.g + ' ' + (a.t || '-') + ' proxy=' + (a.state || '-'));
        }
      } catch (_) {}
    };
    const down = (ev) => {
      clearMyTimer();
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      // Ignore callbacks from replaced sockets.
      if (inputSock !== s) { dbg('input: stale socket callback ignored (#' + myAttempt + ')'); return; }
      inputSock = null;
      dbg('input socket down #' + myAttempt +
          ' after=' + Math.round(nowMs() - myDialAt) + 'ms' +
          ' code=' + ((ev && ev.code) || '-') + ' -> reconnect');
      scheduleInputReconnect();
    };
    s.onclose = down;
    s.onerror = down;
  }
  function sendTouch(type, points) {
    if (type === 'start') {
      gestureSent = 0;
      gestureDropped = 0;
      gestureCoalesced = 0;
      gestureStartPoints = formatPoints(points);
      gestureID++;
    }
    if (!inputSock || inputSock.readyState !== WebSocket.OPEN) {
      gestureDropped++;
      if (type === 'end' || type === 'cancel') finishGesture(type);
      return false;
    }
    try {
      const msg = { t: type, points };
      if (KBD_LOG) { msg.d = KBD_SID; msg.g = gestureID; }
      inputSock.send(JSON.stringify(msg));
      gestureSent++;
      if (type === 'end' || type === 'cancel') finishGesture(type);
      return true;
    } catch (_) {
      gestureDropped++;
      if (type === 'end' || type === 'cancel') finishGesture(type);
      return false;
    }
  }

  // Map a screen point to remote framebuffer px (= remote CSS px in magnify,
  // where deviceScaleFactor is 1). Uses the canvas backing size so it's correct
  // whether the stream is shown 1:1 or scaled.
  function touchToRemote(sx, sy) {
    const screen = getScreenElement();
    const canvas = screen ? screen.querySelector('canvas') : null;
    if (!canvas) return null;
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return null;
    // CDP Input.dispatchTouchEvent wants remote CSS px (layout viewport). In
    // fit-to-width the framebuffer (device px) is SMALLER than the CSS viewport
    // (deviceScaleFactor < 1), so map through the reported CSS viewport when
    // known; fall back to the framebuffer backing size (which equals CSS px when
    // dsf == 1, i.e. normal magnify) before the first /kbd signal arrives.
    const viewport = getViewport();
    const remW = (viewport && viewport.w > 0) ? viewport.w : (canvas.width || cr.width);
    const remH = (viewport && viewport.h > 0) ? viewport.h : (canvas.height || cr.height);
    const point = {
      x: Math.round((sx - cr.left) * (remW / cr.width)),
      y: Math.round((sy - cr.top) * (remH / cr.height)),
    };
    // Verbose tier: this fires per pointer sample, so it is debug-flag only.
    dbgv('input map raw=' + Math.round(sx) + ',' + Math.round(sy) +
        ' out=' + point.x + ',' + point.y +
        ' rect=' + Math.round(cr.left) + ',' + Math.round(cr.top) + ',' + Math.round(cr.width) + 'x' + Math.round(cr.height) +
        ' vp=' + Math.round(remW) + 'x' + Math.round(remH) +
        ' canvas=' + (canvas.clientWidth || 0) + 'x' + (canvas.clientHeight || 0));
    return point;
  }
  // CDP's touch model tracks the CURRENTLY-ACTIVE points and diffs each event
  // against the previous set to decide press/move/RELEASE. So we always map
  // e.touches (the points still on the surface) — never changedTouches. On the
  // last finger-up e.touches is empty, which is exactly the "release everything"
  // payload (and precisely what a real device sends on its final touchend).
  //
  // Falling back to changedTouches here was a bug: on the final touchend it
  // re-sent the just-lifted finger as still-active, so CDP never released it. A
  // pinch then left TWO phantom fingers pressed on the remote — read as an
  // unending pinch (the page keeps zooming) and blocking every later tap.
  function collectPoints(e) {
    const list = e.touches || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const m = touchToRemote(list[i].clientX, list[i].clientY);
      if (m) out.push(m);
    }
    return out;
  }

  // Stretch the coalesce interval as the measured link latency grows: on 3G, 30
  // tiny WS messages/sec saturate the uplink and head-of-line-block the terminal
  // touchEnd, so the gesture wedges. touchEnd always flushes the final position
  // (flushPendingMove), so the drag still finishes at the real point.
  function moveIntervalMs() {
    // Touch cadence tracks network RTT only.
    const l = linkRtt();
    if (l > 0 && l < 150) return MOVE_INTERVAL_FULL_MS; // measured healthy link
    if (l < 300) return MOVE_INTERVAL_FAST_MS;
    // Ramp fast->slow across ~300..1500ms RTT, then hold at the slow floor.
    const t = Math.min(1, (l - 300) / 1200);
    return Math.round(MOVE_INTERVAL_FAST_MS + t * (MOVE_INTERVAL_SLOW_MS - MOVE_INTERVAL_FAST_MS));
  }
  let pendingMovePts = null, moveTimer = null, lastMoveAt = 0;
  function flushMove() {
    moveTimer = null;
    if (!pendingMovePts) return;
    lastMoveAt = nowMs();
    sendTouch('move', pendingMovePts);
    pendingMovePts = null;
  }
  function queueMove(points) {
    // Only a FORWARDED remote scroll/drag shifts the remote doc (and thus stales
    // our rects); a local pan (zoomScale>1) leaves remoteTouchActive false.
    if (TOUCH_INPUT && getRemoteTouchActive()) noteRemoteScroll();
    if (pendingMovePts) gestureCoalesced++;
    pendingMovePts = points;
    if (moveTimer) return;
    moveTimer = setTimeout(flushMove, Math.max(0, moveIntervalMs() - (nowMs() - lastMoveAt)));
  }
  function cancelPendingMove() {
    if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
    pendingMovePts = null;
  }
  // Deliver the last queued move so a drag ends at the real final point (touchEnd).
  function flushPendingMove() {
    if (pendingMovePts) { if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; } flushMove(); }
  }

  // Network-back kick: reconnect the input socket immediately (bypass the 1s
  // reconnect timer). No-op unless the native touch channel is in use.
  function kick() {
    if (!MAGNIFY) return;
    // Replace only overdue connection attempts.
    if (inputSock && inputSock.readyState === WebSocket.CONNECTING) {
      if (nowMs() - inputDialAt < INPUT_CONNECT_TIMEOUT_MS) return;
      dbg('kick: replacing an overdue input connect');
      try { inputSock.close(); } catch (_) {}
      inputSock = null;
    }
    if (!inputSock) {
      if (inputReconnectTimer !== null) { clearTimeout(inputReconnectTimer); inputReconnectTimer = null; }
      connectInput();
    }
  }

  return {
    connectInput, sendTouch, sendPointerClick, touchToRemote, collectPoints,
    queueMove, cancelPendingMove, flushPendingMove, kick,
    getInputSock: () => inputSock,
    inputReady: () => !!inputSock && inputSock.readyState === WebSocket.OPEN,
    gestureID: () => gestureID,
  };
}
