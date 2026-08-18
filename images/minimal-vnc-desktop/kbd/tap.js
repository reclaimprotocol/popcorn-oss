// tap.js — tap/touch gesture classification, the tap->keyboard hit-test, and
// screen->remote coordinate mapping.
//
// The gesture handlers own CLASSIFICATION (which touch means what: pinch, pan,
// native multi-touch, tap, long-press); the pinch/pan state machines live in
// ./kbd/viewport-transform.js and the wire in ./kbd/touch-channel.js — this
// module calls both. handleTap is the synchronous, zero-round-trip tap
// classifier: it maps the tap to remote CSS px and tests it against the
// editable rects the extension streams, so it behaves identically at 50ms or
// 5s RTT.
//
// Owns the tap/touch state (tapStart, lastTap*, lastTouchAt, lastRemoteScrollAt)
// — applySignal's recovery-raise window and raiseKeyboard's proxy placement read
// it via the exposed getters. installTouchHandlers() attaches the document-level
// touch listeners plus the compat-mouse swallow (a tap fires BOTH our CDP touch
// AND synthetic mouse events; noVNC must only ever see one input path).

import { isAndroid, isIOS, isTouch, STATELESS, TOUCH_INPUT, nowMs } from './env.js';
import { dbg, KBD_DEBUG } from './diag.js';
import { DISMISS_MAX_MS } from './latency.js';
import { showTapRipple } from './ripple.js';
import { reportInteraction } from './host-bridge.js';
import { formatPoint, formatRects } from './diag-geometry.js';

export function createTap({
  vt,                               // viewport-transform instance (gesture state machines)
  beginPinch, updatePinch, endPinch, beginPan, updatePan, // vt aliases
  sendTouch, sendPointerClick, collectPoints, queueMove, cancelPendingMove, flushPendingMove, touchToRemote, // touch-channel
  onMagButton, pasteFromDevice,     // controls
  onDialogSheet,                    // JS dialog sheet (kbd/dialog.js) — own UI, not the stream
  flushLocalClipboard,              // clipboard
  raiseKeyboard, dismissKeyboard, armDismiss, parkProxyOffscreen, // core (hoisted)
  zoomToHitField,                    // immediate legacy-page field zoom (core)
  inputReady,                        // is the CDP touch channel usable right now?
  getKeyboardActive, getKeyboardJustDismissed, getEcMode,
  getRemoteFocusKey, getInputRects, getXFrames, getViewport, getLastNonEmptyRectsAt, getRectsTruncated,
  getRemoteScrollBottom, getFocusedScrollContainer,
  getGestureID,
  getProxy, getScreenElement,
}) {
  let remoteTouchActive = false; // a touch 'start' is currently forwarded to the remote
  let lastTouchAt = 0;           // last real touch — distinguishes compat-mouse events
  let lastRemoteScrollAt = 0;    // when a forwarded remote scroll/drag last moved (rects lag it)

  // Keyboard-pan gesture (the occluded-content reachability fix). With an
  // overlay keyboard up at zoom 1, the remote page's scroll range runs out with
  // the last screenful still behind the keys — the remote viewport was sized
  // for no keyboard, and resizing it is the re-emulate ping-pong fit.js avoids.
  // clampPan already extends the local pan range by the occlusion
  // (vt.kbdPanInset); this state machine is what lets a finger reach it at
  // zoom 1, where a single finger otherwise forwards straight to the remote:
  //
  //   touchstart   DEFER (don't forward yet) — kbdPan = {mode:'pending'}
  //   first move   route by direction: drag-up goes LOCAL only when the remote
  //                is believed at its scroll bottom (remoteAtBottom), drag-down
  //                goes LOCAL only while extension budget is spent (panY < 0) —
  //                every other drag forwards to the remote exactly as before,
  //                with the touch 'start' replayed at the ORIGINAL point so the
  //                remote sees the full drag distance
  //   local drag   vt pan, clamped; when the finger outruns a clamp edge by
  //                HANDOFF_SLOP the gesture HANDS OFF to the remote (one-way)
  //   touchend     no move = a tap: synthesize the remote tap like the zoomed
  //                path does (the touch was never forwarded)
  //
  // Ordering is native: page scrolls first, the local pan covers only the final
  // keyboard-height sliver past the remote's scroll bottom.
  let kbdPan = null;             // { mode:'pending'|'local'|'remote', x0, y0, panY0, yAtLocal }
  const KBD_PAN_SLOP = 6;        // px before the route decision (direction is noise below this)
  const HANDOFF_SLOP = 12;       // px of clamp overrun before a local drag hands off remote

  // Is the remote page at (or without) vertical scroll? sb === 0 covers both
  // "scrolled to the bottom" and "no scroll at all" (the login-form case, where
  // it is correct from the first report with no staleness window). Deliberately
  // NO freshness check against lastRemoteScrollAt: a stale-sb misroute to local
  // costs one bounded slide before the handoff forwards to the remote anyway,
  // while a staleness gate that reads its own dead swipes as scrolls can wedge
  // routing at the real bottom, where no scroll event ever fires to refresh sb.
  function remoteAtBottom(touch) {
    const sc = getFocusedScrollContainer ? getFocusedScrollContainer() : null;
    const point = touch && screenToRemote(touch.clientX, touch.clientY);
    if (sc && point && point.rx >= sc.x && point.rx <= sc.x + sc.w &&
        point.ry >= sc.y && point.ry <= sc.y + sc.h) {
      return typeof sc.b === 'number' && sc.b <= 2;
    }
    const sb = getRemoteScrollBottom ? getRemoteScrollBottom() : null;
    return typeof sb === 'number' && sb <= 2;
  }

  const TAP_MAX_MS = 350;
  const LONGPRESS_PASTE_MS = 500; // hold this long on a text field -> paste pill
  const TAP_MAX_MOVE_PX = 12;
  let tapStart = null;
  let lastTapAt = 0;
  let lastTapX = 0, lastTapY = 0;
  let tapSeq = 0;
  let lastTapWasMiss = false;    // last tap was a confirmed non-input (see handleTap):
                                 // suppresses the recovery-raise so an ambient focus
                                 // flap can't re-summon the keyboard onto a tap that
                                 // deliberately landed off any field.

  function withinScreen(target) {
    if (!(target instanceof Element)) return false;
    const proxy = getProxy();
    if (proxy && target === proxy) return false;
    const screen = getScreenElement();
    return screen ? screen.contains(target) : true;
  }


  // Manual keyboard button: focus the remote input nearest the visible viewport
  // centre (so typed keys have a target) then raise. The CDP tap focuses the
  // field; its focus signal + our raise bring the keyboard up. Only meaningful
  // with the touch channel (magnify); plain desktop mode just raises.
  // Focus the remote input nearest an ANCHOR point. The anchor is the user's last
  // content tap (their expressed intent — "the field I just poked") when recent,
  // else the viewport centre. Manual invoke uses this to target the field you
  // tapped rather than whatever the page auto-focused (e.g. a country combobox).
  function focusClosestInput() {
    const currentInputRects = getInputRects();
    if (!TOUCH_INPUT || !currentInputRects || !currentInputRects.length) {
      dbg('focusClosestInput: no target (touch=' + (TOUCH_INPUT ? 1 : 0) +
          ' rects=' + (currentInputRects ? currentInputRects.length : 0) + ')');
      return false;
    }
    // Anchor: recent tap → its remote point; else viewport centre.
    const tapFresh = lastTapAt && (nowMs() - lastTapAt) < 15000;
    const anchor = tapFresh ? screenToRemote(lastTapX, lastTapY)
                            : screenToRemote(window.innerWidth / 2, window.innerHeight / 2);
    const ax = anchor ? anchor.rx : 0, ay = anchor ? anchor.ry : 0;
    let best = null, bestD = Infinity;
    for (const r of getInputRects()) {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const d = anchor ? ((cx - ax) * (cx - ax) + (cy - ay) * (cy - ay)) : cy;
      if (d < bestD) { bestD = d; best = { x: Math.round(cx), y: Math.round(cy) }; }
    }
    if (!best) return false;
    // A zero-duration tap can miss on some remote widgets; hold the press briefly
    // (like a real finger) so the remote reliably fires focus/click on the field.
    dbg('focusClosestInput -> tap ' + best.x + ',' + best.y +
        ' (anchor=' + (tapFresh ? 'tap' : 'centre') + ', ' + currentInputRects.length + ' rects)');
    sendTouch('start', [best]);
    setTimeout(() => { sendTouch('end', []); }, 60);
    return true;
  }


  function onTouchStart(e) {
    lastTouchAt = nowMs(); // mark real touch so compat-mouse events are distinguishable
    if (onMagButton(e.target)) return; // let the magnify button handle its own tap
    if (onDialogSheet && onDialogSheet(e.target)) return; // dialog sheet owns its taps
    const n = e.touches ? e.touches.length : 1;
    if (isTouch) {
      if (n === 2) {
        // EXACTLY two fingers = client pinch-zoom, handled locally in BOTH magnify
        // and desktop mode (noVNC gives the base fit via scaleViewport; our CSS
        // transform zooms on top). Cancel any remote touch the first finger began.
        cancelPendingMove();
        if (remoteTouchActive) { sendTouch('cancel', []); remoteTouchActive = false; }
        tapStart = null; kbdPan = null; vt.clearPan();
        beginPinch(e);
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (n >= 3 && TOUCH_INPUT) {
        // 3+ fingers = a genuine multi-touch the remote wants (games, maps,
        // drawing). Abandon any pinch (keep the zoom level) and forward every
        // point so the remote sees the full multi-touch.
        vt.clearGesture(); // silent — keep the zoom level, no snap-back
        cancelPendingMove();
        sendTouch('start', collectPoints(e));
        remoteTouchActive = true;
        tapStart = null; kbdPan = null;
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        return;
      }
      // Single finger.
      if (TOUCH_INPUT) {
        if (vt.zoomScale() > 1) {
          // Zoomed in: one finger PANS the view locally (no remote drag).
          beginPan(e);
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
        } else if (getKeyboardActive() && vt.kbdPanInset() > 0) {
          // Overlay keyboard up at zoom 1: DEFER — the route (local keyboard-pan
          // vs remote forward) needs the drag direction, known only at the first
          // move. A no-move touch is a tap and is synthesized on touchend, the
          // same way the zoomed path synthesizes its taps. kbdPanInset is 0 in
          // layout-resize mode and for floating keyboards, so those keep the
          // immediate-forward path below untouched.
          vt.cancelFling(); // grabbing again stops an in-flight release glide
          const t0 = e.touches && e.touches[0];
          if (t0) kbdPan = { mode: 'pending', x0: t0.clientX, y0: t0.clientY, panY0: 0, yAtLocal: 0, vy: null, lastY: 0, lastT: 0 };
          e.stopPropagation();
          // preventDefault keeps the proxy focused, exactly as the forward path
          // below does while the keyboard is up.
          if (e.cancelable) e.preventDefault();
        } else {
          cancelPendingMove();
          sendTouch('start', collectPoints(e));
          remoteTouchActive = true;
          e.stopPropagation(); // block noVNC's gesture->mouse path
          // With the keyboard up, a touch would blur the focused proxy and dismiss
          // it; preventDefault keeps focus so you can scroll while typing.
          if (getKeyboardActive() && e.cancelable) e.preventDefault();
        }
      }
      // Desktop mode (!TOUCH_INPUT) single finger: leave it to noVNC's touch->mouse.
      // Its mapping reads the canvas getBoundingClientRect, which reflects our zoom
      // transform, so clicks land correctly even when zoomed.
    }
    if (e.touches && e.touches.length > 1) { tapStart = null; return; }
    const t = e.changedTouches ? e.changedTouches[0] : e;
    if (!t) return;
    // Instant local feedback at the touch point (drawn this frame, before any
    // remote round-trip). Only within the stream, so it doesn't fire on the
    // off-screen proxy or viewer chrome.
    if (withinScreen(e.target)) showTapRipple(t.clientX, t.clientY);
    tapStart = { t: nowMs(), x: t.clientX, y: t.clientY, target: e.target, moved: false };
  }

  // One keyboard-pan move. Owns the route decision (first move past the slop)
  // and the one-way local->remote handoff. Handing off nulls kbdPan and starts
  // the remote touch, so every later move takes the ordinary remoteTouchActive
  // path — the forwarded-gesture machinery (queueMove throttling, flush on end,
  // noteRemoteScroll, motion quality) is reused, never duplicated.
  function handleKbdPanMove(e, t0) {
    const dx = t0.clientX - kbdPan.x0, dy = t0.clientY - kbdPan.y0;
    if (kbdPan.mode === 'pending') {
      if (Math.abs(dx) < KBD_PAN_SLOP && Math.abs(dy) < KBD_PAN_SLOP) return;
      if (tapStart) tapStart.moved = true;
      const vertical = Math.abs(dy) >= Math.abs(dx);
      // Drag-up reveals below: local only once the remote can't scroll further.
      // Drag-down reveals above: local only while extension budget is spent —
      // unwind it before the remote scrolls back up. Horizontal drags (and
      // everything else) belong to the remote (carousels, sliders).
      const local = vertical &&
        ((dy < 0 && remoteAtBottom(t0)) || (dy > 0 && vt.panY() < -0.5));
      if (!local) {
        handKbdPanToRemote(e, kbdPan.x0, kbdPan.y0);
        return;
      }
      kbdPan.mode = 'local';
      kbdPan.panY0 = vt.panY();
      kbdPan.yAtLocal = t0.clientY;
      beginPan(e);
      return;
    }
    // mode === 'local': pan, clamped by clampPan's extended range; when the
    // finger outruns a clamp edge the drag has content the pan can't reach —
    // hand the rest of the gesture to the remote (rubber-band at a real end).
    updatePan(e);
    if (tapStart) tapStart.moved = true;
    // Track exit velocity (px/ms, finger == panY at zoom 1) for the release
    // glide — a short EMA so one jittery sample can't dominate the flick.
    const now = nowMs();
    if (kbdPan.lastT && now > kbdPan.lastT) {
      const inst = (t0.clientY - kbdPan.lastY) / (now - kbdPan.lastT);
      kbdPan.vy = kbdPan.vy == null ? inst : kbdPan.vy * 0.6 + inst * 0.4;
    }
    kbdPan.lastY = t0.clientY; kbdPan.lastT = now;
    const desired = kbdPan.panY0 + (t0.clientY - kbdPan.yAtLocal);
    if (Math.abs(desired - vt.panY()) > HANDOFF_SLOP) {
      vt.clearPan();
      handKbdPanToRemote(e, t0.clientX, t0.clientY);
    }
  }
  // Start the remote touch mid-gesture. `sx, sy` is where the remote's finger
  // goes DOWN: the original touch point for a routed-remote gesture (so the
  // remote sees the full drag distance), the current point for a handoff (the
  // local pan already consumed the earlier travel).
  function handKbdPanToRemote(e, sx, sy) {
    kbdPan = null;
    cancelPendingMove();
    const sp = touchToRemote(sx, sy);
    if (!sp) return;
    sendTouch('start', [sp]);
    remoteTouchActive = true;
    queueMove(collectPoints(e));
  }

  function onTouchMove(e) {
    lastTouchAt = nowMs();
    if (onMagButton(e.target)) return;
    if (onDialogSheet && onDialogSheet(e.target)) return;
    if (isTouch) {
      if (vt.pinchActive()) { updatePinch(e); e.stopPropagation(); if (e.cancelable) e.preventDefault(); return; }
      if (kbdPan) {
        const t0 = e.touches && e.touches[0];
        if (t0) handleKbdPanMove(e, t0);
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (vt.panActive()) {
        updatePan(e);
        if (tapStart) {
          const pt = e.changedTouches ? e.changedTouches[0] : e;
          if (pt && (Math.abs(pt.clientX - tapStart.x) > TAP_MAX_MOVE_PX ||
                     Math.abs(pt.clientY - tapStart.y) > TAP_MAX_MOVE_PX)) tapStart.moved = true;
        }
        e.stopPropagation(); if (e.cancelable) e.preventDefault();
        return;
      }
      if (TOUCH_INPUT && getKeyboardActive() && vt.zoomScale() > 1) {
        // Match the start-side lock above. Mark the gesture as moved so its end
        // cannot be mistaken for a tap and activate whatever sits underneath.
        if (tapStart) tapStart.moved = true;
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (TOUCH_INPUT && remoteTouchActive) {
        queueMove(collectPoints(e)); // throttled to ~30fps
        e.stopPropagation();
        if (e.cancelable) e.preventDefault(); // stop viewer-page scroll/overscroll
      }
    }
    if (tapStart) {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      if (t && (Math.abs(t.clientX - tapStart.x) > TAP_MAX_MOVE_PX ||
                Math.abs(t.clientY - tapStart.y) > TAP_MAX_MOVE_PX)) {
        tapStart.moved = true;
      }
    }
  }

  function onTouchEnd(e) {
    lastTouchAt = nowMs();
    if (onMagButton(e.target)) return;
    if (onDialogSheet && onDialogSheet(e.target)) return;
    // A tap is a transient activation — the moment iOS Safari allows a deferred
    // remote->local clipboard write to succeed.
    flushLocalClipboard();
    if (isTouch) {
      // A released LOCAL keyboard-pan coasts to rest with the finger's exit
      // velocity (a finger-tracked pan that stops dead feels un-native). It was
      // a drag, not a tap, so settle here and return — before the generic
      // panActive branch clears it with no glide. A 'pending' kbd-pan (no move)
      // is a deferred tap and must fall through to the synthesis below, so only
      // 'local' is consumed here.
      if (kbdPan && kbdPan.mode === 'local') {
        const vy = kbdPan.vy;
        kbdPan = null;
        vt.clearPan();
        if (typeof vy === 'number') vt.flingPanY(vy);
        e.stopPropagation();
        tapStart = null;
        return;
      }
      if (vt.pinchActive()) {
        // A finger lifted mid-pinch. If one remains AND we're zoomed in magnify,
        // continue as a pan; otherwise settle the pinch.
        if (e.touches && e.touches.length === 1 && vt.zoomScale() > 1 && TOUCH_INPUT) { vt.clearPinch(); beginPan(e); }
        else endPinch();
        e.stopPropagation();
        tapStart = null;
        return;
      }
      if (vt.panActive()) {
        vt.clearPan();
        e.stopPropagation();
        // fall through to tap detection (a no-move touch while zoomed = a tap)
      } else if (TOUCH_INPUT && remoteTouchActive) {
        // Deliver the last queued move so the drag ends at the real final point.
        flushPendingMove();
        // A tap inside a cross-origin iframe ends with CANCEL, not END, and is then
        // re-issued as a mouse click below. touchEnd is what Chrome turns into a
        // synthesized click, and in SOME cross-origin frames it does so while in
        // others it does not — the reCAPTCHA anchor got no click, but the image
        // challenge did, so adding a click there selected two tiles from one tap.
        // Cancelling removes that ambiguity: the frame gets exactly one activation,
        // the mouse click, whatever Chrome would have done with the touch.
        const xf = isXFrameTap(e);
        sendTouch(xf ? 'cancel' : 'end', xf ? [] : collectPoints(e));
        remoteTouchActive = !!(e.touches && e.touches.length > 0);
        e.stopPropagation();
      }
    }
    const start = tapStart;
    tapStart = null;
    // A keyboard-pan gesture that never left 'pending' is a deferred TAP — the
    // touch was never forwarded, so the synthesis below must cover it (a local
    // 'local' drag returns via start.moved; a handoff already nulled kbdPan and
    // ended through the remote branch above).
    const kp = kbdPan;
    kbdPan = null;
    if (!start) return;
    if (start.moved) return; // a drag/scroll/pan — not a tap
    if (e.touches && e.touches.length > 0) return;
    const t = e.changedTouches ? e.changedTouches[0] : e;
    if (!t) return;
    const heldMs = nowMs() - start.t;
    // Replay a DEFERRED touch (zoomed pan, or a keyboard-pan that never moved)
    // as a real press the remote can act on. The press is held ~60ms rather
    // than sent as a zero-duration start+end, because some remote widgets miss
    // an instantaneous tap — the same reason focusClosestInput holds its press.
    const synthesizeDeferredTap = (sx, sy) => {
      const pt = touchToRemote(sx, sy);
      if (!pt) return;
      sendTouch('start', [pt]);
      setTimeout(() => { sendTouch('end', []); }, 60);
    };
    if (heldMs > TAP_MAX_MS) {
      // A deferred keyboard-pan touch was never forwarded, so a slow press
      // (350ms+ — a deliberate press on a button, a long-press for a context
      // menu or text selection) would otherwise reach the remote as NOTHING.
      // Forward it here before the paste-pill check below, which needs the
      // remote to have focused the field under the finger for the text to land
      // in the right place.
      if (kp && TOUCH_INPUT && withinScreen(start.target) && withinScreen(e.target) &&
          !inCrossOriginFrame(t.clientX, t.clientY)) {
        synthesizeDeferredTap(t.clientX, t.clientY);
      }
      // Long-press on a remote TEXT FIELD -> native iOS "Paste" pill. This
      // touchend is a user gesture, so readText() pops the system paste
      // confirmation right where the finger is — the closest a page can get to
      // the native field callout (the invisible proxy can't show one). The
      // remote saw the tap-and-hold and focused the field, so the text lands
      // in the right place.
      if (heldMs >= LONGPRESS_PASTE_MS && !start.moved &&
          withinScreen(start.target) && withinScreen(e.target) &&
          hitTest(t.clientX, t.clientY) === 'hit') {
        dbg('longpress -> paste pill');
        pasteFromDevice();
      }
      return;
    }
    if (!withinScreen(start.target) || !withinScreen(e.target)) return;
    // Magnify + zoomed (or a deferred keyboard-pan touch): we intercepted the
    // touch for panning, so synthesize the remote tap. Desktop mode leaves
    // single-finger to noVNC, which already clicked at the transform-adjusted
    // point.
    if ((vt.zoomScale() > 1 || kp) && TOUCH_INPUT && !inCrossOriginFrame(t.clientX, t.clientY)) {
      synthesizeDeferredTap(t.clientX, t.clientY);
    }
    // The touch above was cancelled rather than ended inside a cross-origin iframe
    // (see the touchend branch), so the activation is this click.
    //
    // Keep the cancel + compatibility click on the SAME /input -> CDP command
    // queue. Sending the click over VNC races the touchCancel on a second socket:
    // the reCAPTCHA grid then receives a press from one cursor position and a
    // release from another, so quick tile taps become missed drags. The proxy
    // serializes cancel, mousePressed and mouseReleased in order. VNC remains a
    // last-resort fallback only while the /input socket is unavailable.
    if (TOUCH_INPUT && inCrossOriginFrame(t.clientX, t.clientY)) {
      const cp = touchToRemote(t.clientX, t.clientY);
      if (cp && sendTouch('click', [cp])) {
        dbg('compat click via ordered CDP');
      } else if (sendPointerClick && sendPointerClick(t.clientX, t.clientY)) {
        dbg('compat click via VNC (input unavailable)');
      }
    }
    // Use VNC for taps until native touch is ready.
    if (TOUCH_INPUT && inputReady && !inputReady() &&
        !inCrossOriginFrame(t.clientX, t.clientY) && sendPointerClick) {
      if (sendPointerClick(t.clientX, t.clientY)) dbg('tap via VNC (input not ready yet)');
    }
    // Tap: the remote click/focus is produced by the (real or synthetic) touch
    // above; this only drives the keyboard hit-test.
    handleTap(t.clientX, t.clientY);
  }


  // Synchronous, zero-round-trip tap classification: map the tap to remote CSS
  // px and test it against the editable rects the extension streams. Behaves
  // identically at 50ms or 5s RTT.
  //   'hit'     tap is inside a known input  -> pop
  //   'miss'    tap is outside all inputs    -> never pop (dismiss if up)
  //   'unknown' no rects for this area (cold cache / cross-origin) -> fall back
  // Map a screen tap to remote CSS px. noVNC scales the framebuffer to fit the
  // canvas, and the extension reports the remote viewport (currentViewport) in
  // CSS px, so scale by remote-viewport / displayed-canvas. This holds in
  // magnify too — magnify only changes what the remote renders (mobile layout
  // at high DSF), not how noVNC displays it.
  function screenToRemote(sx, sy) {
    const currentViewport = getViewport();
    if (!currentViewport) return null;
    const screen = getScreenElement();
    const canvas = screen ? screen.querySelector('canvas') : null;
    if (!canvas) return null;
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return null;
    return {
      rx: (sx - cr.left) * (currentViewport.w / cr.width),
      ry: (sy - cr.top) * (currentViewport.h / cr.height),
      cr,
    };
  }

  // Chrome synthesizes `click` from a CDP touch tap in the MAIN frame, but NOT
  // inside an out-of-process (cross-origin) iframe. Measured from inside
  // reCAPTCHA's own frame: a tap delivered pointerdown/touchstart/touchend, all
  // isTrusted, and no click — so the checkbox ignored every tap — while a mouse
  // click at the identical point delivered pointerdown/mousedown/click and it
  // activated. Anything inside such a frame is untappable without this.
  //
  // Sent ONLY for taps landing in one of those frames (rects streamed by the
  // extension as `xf`). It cannot be unconditional: in the main frame the touch
  // already produces a click, so an extra one would double-fire — a harmless
  // re-toggle on a checkbox, a double submit on a button.
  // Is THIS touchend a tap (not a drag) landing in a cross-origin frame? Checked
  // before the tap block runs, because the end/cancel decision happens earlier.
  function isXFrameTap(e) {
    if (!TOUCH_INPUT) return false;
    if (tapStart && tapStart.moved) return false;
    if (e.touches && e.touches.length > 0) return false;
    const t = e.changedTouches ? e.changedTouches[0] : null;
    if (!t) return false;
    return inCrossOriginFrame(t.clientX, t.clientY);
  }

  function inCrossOriginFrame(sx, sy) {
    const frames = getXFrames ? getXFrames() : null;
    if (!frames || !frames.length) return false;
    const m = screenToRemote(sx, sy);
    if (!m) return false;
    for (const f of frames) {
      if (m.rx >= f.x && m.rx <= f.x + f.w && m.ry >= f.y && m.ry <= f.y + f.h) return true;
    }
    return false;
  }

  function hitRectAt(sx, sy) {
    if (!getInputRects().length || !getViewport()) return null;
    const m = screenToRemote(sx, sy);
    if (!m) return null;
    const rx = m.rx, ry = m.ry;
    const pad = 6; // forgiveness for small fields / imprecise touches
    for (const r of getInputRects()) {
      if (rx >= r.x - pad && rx <= r.x + r.w + pad &&
          ry >= r.y - pad && ry <= r.y + r.h + pad) {
        return r;
      }
    }
    return null;
  }

  function hitTest(sx, sy) {
    if (!getInputRects().length || !getViewport()) return 'unknown';
    const r = hitRectAt(sx, sy);
    if (r) return 'hit';
    // A forwarded remote scroll just happened but our rects still predate it —
    // they lag by the extension report (250ms/1500ms) + tunnel RTT, wide on 3G.
    // Downgrade the miss to 'unknown' so a tap on a now-visible field isn't read
    // as an off-field dismiss; self-clears the moment a post-scroll rect lands.
    if (getLastNonEmptyRectsAt() < lastRemoteScrollAt && nowMs() - lastRemoteScrollAt < DISMISS_MAX_MS) return 'unknown';
    // The rect list was capped, so the field under this tap may simply not be in it.
    // 'unknown' keeps the optimistic path (no dismiss); a real miss still needs a full list.
    if (getRectsTruncated && getRectsTruncated()) return 'unknown';
    return 'miss';
  }

  function handleTap(x, y) {
    // A real user tap on the stream, whether or not it lands on a field — the
    // analogue of the CDP path's mousePressed, which is what an embedding host's
    // funnel counts as an interaction. Reported before the justDismissed grace
    // return below: that grace only suppresses our KEYBOARD reaction, and the tap
    // still reached the remote page, so it is still an interaction.
    reportInteraction('click');
    if (getKeyboardJustDismissed()) { dbg('TAP ignored (justDismissed)'); return; } // grace window after a dismiss
    lastTapAt = nowMs();
    lastTapX = x; lastTapY = y; // raiseKeyboard positions the proxy here
    tapSeq++;

    const hitRect = hitRectAt(x, y);
    const hit = hitRect ? 'hit' : hitTest(x, y);
    // Only a CONFIRMED miss (tap inside our rect coverage but on no input) blocks
    // recovery. 'unknown' (no coverage — cross-origin/shadow field) must still
    // allow recovery, so it counts as not-a-miss.
    lastTapWasMiss = (hit === 'miss');
    const m = screenToRemote(x, y);
    const vp = getViewport();
    const canvas = m && m.cr;
    dbg('tap#' + tapSeq + ' g#' + (getGestureID ? getGestureID() : '-') + ' hit=' + hit + ' kbd=' + (getKeyboardActive() ? 1 : 0) +
      ' rfk=' + (getRemoteFocusKey() ? 1 : 0) +
      ' screen=' + formatPoint(x, y) +
      ' remote=' + (m ? formatPoint(m.rx, m.ry) : '-') +
      ' vp=' + (vp ? Math.round(vp.w) + 'x' + Math.round(vp.h) : '-') +
      ' canvas=' + (canvas ? formatPoint(canvas.left, canvas.top) + '+' + Math.round(canvas.width) + 'x' + Math.round(canvas.height) : '-') +
      ' z=' + vt.zoomScale().toFixed(2) + '/' + vt.minZoom().toFixed(2) +
      ' pan=' + formatPoint(vt.panX(), vt.panY()) +
      ' kinset=' + Math.round(vt.kbdPanInset()) +
      ' rects=' + formatRects(getInputRects()) +
      (hitRect ? ' matched=' + formatRects([hitRect]) : ''));
    if (hit === 'hit') {
      // The rect stream is already local and corresponds to the field under
      // this exact tap. Legacy desktop-fit pages must not wait for the remote
      // focus signal (which can be many seconds behind over a tunnel) before
      // becoming readable. The later focus signal merely confirms this move.
      if (hitRect && zoomToHitField) zoomToHitField(hitRect);
      // Re-raise (fixes the Android wedge): the keyboard is down but the remote
      // STILL reports an editable focused (remoteFocusKey set) — a prior local
      // dismiss (Android back/swipe-down, watchdog, miss-tap) never blurred the
      // remote field. Re-tapping that same field doesn't change its focusKey, so
      // applySignal's focusKey-keyed recovery never fires and the keyboard would
      // stay wedged down. The remote already confirms an editable, so raise now.
      if (!getKeyboardActive() && getRemoteFocusKey()) { raiseKeyboard('re-raise'); return; }
      // A rect 'hit' can land on a NON-text control that sits inside an input's
      // box — a password show/hide eye, a <select>/date picker trigger — so
      // popping here would false-fire the keyboard. The CDP tap focuses the real
      // element; if it's genuinely a text field the remote reports editable:true
      // and applySignal's recovery raises then (authoritative, no false pops).
      //
      // iOS is the exception: it only allows a programmatic raise inside the tap
      // gesture, so we must pop now and let editable:false dismiss if it wasn't a
      // text field (a brief flicker on iOS is better than never opening).
      if (STATELESS) {
        // Optimistic & local: a known-input tap raises NOW, on every platform, with
        // NO armDismiss — we never dismiss for lack of a remote confirm (that's the
        // round-trip dependency we're removing). Only a real local event dismisses.
        if (!getKeyboardActive()) raiseKeyboard('tap-hit');
        return;
      }
      // Optimistic raise on EVERY soft-keyboard platform (was iOS-only). A tap on
      // a known input rect pops the keyboard in ONE FRAME instead of waiting a full
      // tunnel round-trip (1-3s on 3G) for the remote's editable:true. This is the
      // single biggest native-feel win on high-latency links.
      //   - A real field: its editable:true confirm cancels armDismiss (clearDismiss
      //     in applySignal) so the keyboard stays up.
      //   - A false hit (an icon inside a text field's box): no confirm arrives, so
      //     armDismiss's RTT-adaptive timer tears it back down. The grace-gate in
      //     applySignal keeps a stale editable:false from doing that prematurely.
      // iOS additionally REQUIRES the in-gesture raise (it forbids a programmatic
      // raise later); Android/EC could wait for the confirm but shouldn't, on 3G.
      if (isIOS || isAndroid || getEcMode()) {
        const wasActive = getKeyboardActive();
        raiseKeyboard('tap-hit');
        if (!wasActive) armDismiss();
      }
      return;
    }
    if (hit === 'miss') {
      if (STATELESS) {
        // Desktop-style: tapping a known non-input NEVER dismisses (the rects are
        // stale-derived, and the tap is already forwarded to the remote as a click).
        // Dismiss stays a deliberate act: the keyboard button or system back.
        if (!getKeyboardActive()) parkProxyOffscreen();
        return;
      }
      // Confirmed non-input tap: never pop. Dismiss if the keyboard is up;
      // otherwise make sure the proxy isn't sitting under this tap.
      if (getKeyboardActive()) dismissKeyboard();
      else parkProxyOffscreen();
      return;
    }
    // 'unknown' — we have no rect coverage for this area (input-less page, cold
    // cache, or a cross-origin/closed-shadow field). Do NOT pop optimistically:
    // that fires on every tap of a page with no text inputs (e.g. a landing
    // page of buttons). lastTapAt is already stamped above, so if this tap did
    // land on a real input the remote's authoritative editable:true will raise
    // the keyboard via applySignal()'s recovery within the tap window.
  }


  // Attach the document-level gesture listeners. touchmove is non-passive so we
  // can preventDefault (block viewer-page scroll/overscroll) while forwarding
  // native touch to the remote.
  function installTouchHandlers() {
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', (e) => {
      if (isTouch) {
        vt.clearGesture(); endPinch(); // null-out FIRST, then the settling snap+compose
        if (TOUCH_INPUT) { cancelPendingMove(); sendTouch('cancel', []); remoteTouchActive = false; }
        e.stopPropagation();
      }
      tapStart = null;
      kbdPan = null;
    }, { capture: true, passive: true });

    // Physical mouse input in magnify is owned by noVNC's wrapped pointer entry
    // points (viewer.js installPointerTransformFix + viewport-transform's
    // unzoomEvent), NOT by a capture listener here: desktop browsers differ on
    // whether the event still reaches document, so intercepting by propagation
    // was unreliable. Correcting the coordinates at noVNC's own boundary is.

    // A tap emits BOTH our CDP touch AND the browser's compatibility mouse events
    // (mousedown/mouseup/click), which noVNC would forward as a SECOND VNC click
    // — the "tap registered twice" bug. Swallow the SYNTHETIC (touch-derived)
    // mouse events before noVNC (capture phase); CDP touch is the single input
    // path. But a REAL pointer (iPad Magic Trackpad, Samsung DeX / Surface mouse,
    // Chromebook touchpad) fires mouse events with NO preceding touch — those
    // must pass through to noVNC's mouse path, or clicking is dead on every
    // tablet-with-pointer in magnify. Chromium marks synthetic events via
    // sourceCapabilities.firesTouchEvents; WebKit lacks it, so fall back to an
    // 800ms window after the last real touch (observed compat-mouse delay).
    if (TOUCH_INPUT) {
      ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick'].forEach((type) => {
        document.addEventListener(type, (e) => {
          if (getProxy() && e.target === getProxy()) return; // let the keyboard proxy work
          if (onMagButton(e.target)) return;       // let the magnify button click
          if (onDialogSheet && onDialogSheet(e.target)) return; // and the dialog sheet's buttons
          const synthetic = e.sourceCapabilities
            ? e.sourceCapabilities.firesTouchEvents === true
            : (nowMs() - lastTouchAt <= 800);
          if (!synthetic) return; // real mouse/trackpad — let noVNC handle it
          e.stopPropagation();
        }, { capture: true });
      });
    }
  }

  return {
    installTouchHandlers, focusClosestInput, screenToRemote,
    // touch-channel wiring (queueMove's rect-staleness stamp + the active flag)
    remoteTouchActive: () => remoteTouchActive,
    noteRemoteScroll() { lastRemoteScrollAt = nowMs(); },
    // applySignal's recovery window + latency learn; raiseKeyboard's proxy spot
    lastTapAt: () => lastTapAt,
    diagnosticTag: () => tapSeq ? ('tap#' + tapSeq + '/+' + Math.round(nowMs() - lastTapAt) + 'ms') : 'tap#-',
    lastTapWasMiss: () => lastTapWasMiss,
    lastTapXY: () => ({ x: lastTapX, y: lastTapY }),
    clearLastTap() { lastTapAt = 0; }, // deliberate dismiss must beat a late confirm
  };
}
