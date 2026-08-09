// viewport-transform.js — the #screen CSS transform: pinch-zoom, pan, and the
// keyboard field-lift, composed in one place.
//
// Pinch-zoom is done ENTIRELY viewer-side, exactly like a real mobile browser:
// we scale/translate #screen with a CSS transform, instantly and with no remote
// round-trip. Forwarding pinch to the remote (the old behavior) needed the
// network AND desynced tap coordinates (visual vs layout viewport), which left
// fingers stuck and zoomed the remote forever. getBoundingClientRect() on the
// canvas reflects this transform, so the screen->remote tap mapping
// (touchToRemote / screenToRemote) keeps working unchanged at any zoom.
//
// Owns: zoomScale / panX / panY / minZoom / appliedLift and the pinch/pan
// gesture state machines. Gesture CLASSIFICATION (which touch means what) stays
// in the core's onTouchStart/Move/End; they call in here.
//
// Deferred deps (arrows — their targets are factories instantiated LATER in the
// core, only ever invoked at runtime): positionMirrorBar, getReadableZoom,
// onZoomSettled (-> setMagnifyState), getFitMode (dbg strings only).
//
// Three gesture-clear semantics, deliberately distinct (do not collapse):
//   clearGesture()            silent null-out, NO snap-back — 3-finger handoff,
//                             and touchcancel BEFORE its endPinch() call
//   clearPinch(); beginPan(e) mid-pinch finger lift continues as a pan
//   endPinch()                settling clear: snaps to the fit floor + composes

import { dbg, dbgv } from './diag.js';
import { nowMs } from './env.js';
import { hostGeometry, postToHost } from './host-bridge.js';

const MAX_ZOOM = 6;
// ?smooth=1 keeps the browser's default (bilinear) canvas scaling while zoomed in,
// for A/B against the nearest-neighbour sharpening in applyCanvasFilter.
const FORCE_SMOOTH = /[?&]smooth=1/.test(location.search);
// Settle delay before switching to nearest-neighbour after a transform burst.
// Longer than the 150ms animated compose so an eased lift/zoom finishes first.
const FILTER_SETTLE_MS = 180;

// Keep #screen on its own GPU layer only WHILE it's transforming. Left on
// permanently, will-change:transform wastes GPU memory for a full-page layer,
// so a debounced timer drops it this long after the last transform write (past
// the 0.15s settle transition).
const LAYER_IDLE_MS = 200;

export function createViewportTransform({
  getScreenElement, getCurrentRect, getCurrentViewport, getLayoutResizeMode,
  getZoomedToField, positionMirrorBar, getReadableZoom, onZoomSettled, getFitMode,
  onZoomFreeze,
}) {
  // Edge-triggered so the per-frame compose doesn't spam the (rfb-touching) setter.
  let zoomFrozen = false;
  function noteZoomFreeze(on) {
    if (on === zoomFrozen) return;
    zoomFrozen = on;
    if (onZoomFreeze) onZoomFreeze(on);
  }
  // The lift we INTEND #screen to have (displayed px). Used only for the applyLift
  // no-op compare; the resting-position math below reads the ACTUAL rendered
  // transform, not this, so it stays correct mid-transition.
  let appliedLift = 0;

  let zoomScale = 1;
  let panX = 0, panY = 0;
  // minZoom is the "fit" floor — the zoom our CSS transform can't go below. It
  // stays 1 in this design (framebuffer/display == the fit): in fit-to-width mode
  // the whole-page down-scaling is done by noVNC's scaleViewport (the framebuffer
  // is rendered at the page's FULL width and noVNC scales it to the viewport), NOT
  // by a sub-1 minZoom. So the overview (zoomScale == minZoom == 1) already shows
  // the whole page, and pinch/zoom compose on top from there.
  let minZoom = 1;
  let pinch = null;    // active 2-finger gesture state
  let panning = null;  // active 1-finger pan (only while zoomed in)

  // The transform #screen is CURRENTLY rendering (px, negative = lifted up), read
  // from computed style so it reflects the live mid-transition value — not the
  // target. getBoundingClientRect() reflects the same live value, so subtracting
  // the two recovers the true resting top at any animation frame. (Using the
  // TARGET appliedLift instead over-corrects while the 0.15s transition lags,
  // making rapid re-calls run the lift away: 0->207->413->620.)
  function currentTranslateY(el) {
    try {
      const t = getComputedStyle(el).transform;
      if (!t || t === 'none') return 0;
      let m = t.match(/^matrix\(([^)]+)\)$/);
      if (m) { const p = m[1].split(','); return parseFloat(p[5]) || 0; }
      m = t.match(/^matrix3d\(([^)]+)\)$/);
      if (m) { const p = m[1].split(','); return parseFloat(p[13]) || 0; }
    } catch (_) {}
    return 0;
  }

  // Single place that writes #screen's transform, composing pan+zoom with the
  // keyboard lift (appliedLift, in screen px). transform-origin is the top-left
  // so pan math is in plain screen px; translate is origin-independent, so the
  // lift keeps behaving exactly as before when not zoomed (scale 1, pan 0).
  function composeScreenTransform(animate) {
    const screen = getScreenElement();
    if (!screen) return;
    screen.style.transition = animate ? 'transform 0.15s ease-out' : 'none';
    screen.style.transformOrigin = '0 0';
    const tx = panX;
    const ty = panY - appliedLift;
    const parts = [];
    if (tx !== 0 || ty !== 0) parts.push('translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px)');
    if (zoomScale !== 1) parts.push('scale(' + zoomScale.toFixed(4) + ')');
    screen.style.transform = parts.join(' ');
    // animate=true means a 150ms transition is about to run this transform, so the
    // scale keeps changing after this call returns — treat it as motion.
    applyCanvasFilter(screen, animate);
    // Any zoom away from 1:1 must freeze the remote framebuffer size, because
    // noVNC sizes it from this element's (now transformed) bounding rect. Reported
    // from the single transform writer so no zoom path can forget to.
    noteZoomFreeze(zoomScale > 1.01);
    promoteLayer(screen);
  }

  // Sharpen magnified text by turning OFF the browser's smoothing while zoomed in.
  //
  // At the readable zoom the mapping is an exact integer: readableZoom() is
  // fitLayoutW/innerWidth, so device-px per framebuffer-px works out to the device
  // pixel ratio itself (e.g. (393/980) * 2.49 * 3 == 3.0). Magnifying a bitmap by
  // exactly 3x is the one case where nearest-neighbour is strictly better than
  // bilinear: it reproduces each framebuffer pixel exactly, where smoothing invents
  // intermediate pixels and visibly smears glyph edges — the "blurry text" everyone
  // notices first on a login form. Costs nothing: no extra bytes, no remote work.
  //
  // Only while zoomed IN. When zoomed out (the whole-page overview) the canvas is
  // DOWNSCALED, and nearest-neighbour downsampling drops pixels instead of averaging
  // them, which aliases thin strokes into a shimmering mess — smoothing is correct
  // there. Kill-switch for on-device A/B: ?smooth=1 keeps the browser default.
  //
  // And only while the transform is AT REST. Nearest-neighbour snaps each output
  // pixel to whichever source pixel it lands on, so while the scale/translate is
  // CHANGING (pinch, pan, scroll prediction, the animated lift) that assignment
  // flips frame to frame and the whole image crawls — reported as a CRT-like buzz
  // while zooming. Smoothing during the gesture hides it (motion masks softness
  // anyway); the sharp version snaps in FILTER_SETTLE_MS after the last write,
  // which is where the user actually reads.
  let filterTimer = null;
  function writeCanvasFilter(sharp) {
    const screen = getScreenElement();
    const canvas = screen && screen.querySelector && screen.querySelector('canvas');
    if (!canvas) return;
    const want = sharp ? 'pixelated' : '';
    if (canvas.style.imageRendering !== want) canvas.style.imageRendering = want;
  }
  function applyCanvasFilter(screen, animate) {
    if (FORCE_SMOOTH) return;
    const moving = !!pinch || !!panning || !!animate;
    writeCanvasFilter(!moving && zoomScale > 1.05);
    // Re-evaluate after the burst: the last compose of a gesture is the one that
    // never gets a follow-up, so without this the view would stay smooth until the
    // next unrelated transform. The settle callback writes DIRECTLY rather than
    // recursing — a re-entrant call would re-arm itself for as long as any burst
    // state stayed set, which is an endless timer chain.
    if (filterTimer) { clearTimeout(filterTimer); filterTimer = null; }
    if (moving) {
      filterTimer = setTimeout(() => {
        filterTimer = null;
        writeCanvasFilter(zoomScale > 1.05);
      }, FILTER_SETTLE_MS);
    }
  }

  // Promote #screen to a compositor layer for the duration of a transform burst
  // (pinch/pan/scroll-prediction/lift) so it tracks the finger on low-end phones,
  // then de-promote once motion idles. will-change is a hint for CHANGING props;
  // a static resting transform doesn't need it, so dropping the layer LAYER_IDLE_MS
  // after the last write is free. Idempotent per frame (only writes on transition).
  let layerTimer = null;
  function promoteLayer(screen) {
    if (screen.style.willChange !== 'transform') screen.style.willChange = 'transform';
    if (layerTimer !== null) clearTimeout(layerTimer);
    layerTimer = setTimeout(() => {
      layerTimer = null;
      const s = getScreenElement();
      if (s) s.style.willChange = 'auto';
    }, LAYER_IDLE_MS);
  }

  // Clamp pan so the scaled content stays sensible. Content visual size is the
  // #screen element size (which equals the framebuffer/page size) times zoom;
  // the display is the viewport. If content is wider/taller than the display,
  // clamp so no blank gutters show; if smaller (a fit that doesn't fill), center.
  function clampPan() {
    zoomScale = Math.max(minZoom, Math.min(MAX_ZOOM, zoomScale));
    const screen = getScreenElement();
    // Measure the CANVAS, not #screen. They disagree in several states — #screen is
    // pinned to a fixed pixel size in fit mode, blown up to the full page width
    // during the fit dance, and the canvas is whatever size the framebuffer
    // currently is (which lags a rotate/keyboard resize, and is frozen outright
    // while zoomed). Clamping against the larger #screen box granted a pan range
    // sized for content that wasn't there, so the visible canvas could be dragged
    // clear out of the viewport leaving the #111 background showing. What the user
    // can see is the canvas, so that is what must stay on screen.
    //
    // offsetWidth is pre-transform (it ignores our scale), which is what the
    // `* zoomScale` below expects. Falls back to #screen, then the window, so a
    // missing canvas degrades to the old behaviour rather than to a zero size —
    // a zero would centre and pin the view, making it undraggable.
    const canvas = screen && screen.querySelector && screen.querySelector('canvas');
    const ew = (canvas && canvas.offsetWidth) || (screen && screen.offsetWidth) || window.innerWidth;
    const eh = (canvas && canvas.offsetHeight) || (screen && screen.offsetHeight) || window.innerHeight;
    // The transform lives on #screen (origin 0,0), but the CANVAS can sit at an
    // OFFSET inside #screen: when the framebuffer is smaller than #screen it's
    // centered within it (the capped-framebuffer / scale-to-fill case). Scaling
    // #screen magnifies that offset too, so the pan must subtract it (offset * zoom)
    // to keep the CANVAS — not #screen's origin — centered/clamped. offsetLeft/Top
    // are the untransformed layout offset, 0 whenever the canvas fills #screen (every
    // non-fill case), so this stays a no-op there.
    // Only compensate in scale-to-fill mode, which is the ONLY caller that raises
    // minZoom above 1 (setFillFloor). Gating on minZoom — not zoomScale — keeps this
    // out of fit-to-width and ordinary pinch-zoom (both minZoom==1), whose canvas may
    // also be letterboxed inside #screen but must not be re-shifted. Also avoids a
    // stale-pan read mid-resize (canvas momentarily larger than the shrunk #screen).
    const filling = minZoom > 1.01;
    const offX = filling ? ((canvas && canvas.offsetLeft) || 0) : 0;
    const offY = filling ? ((canvas && canvas.offsetTop) || 0) : 0;
    const oxz = offX * zoomScale, oyz = offY * zoomScale;
    const dispW = window.innerWidth, dispH = window.innerHeight;
    const cw = ew * zoomScale, ch = eh * zoomScale; // content visual size
    if (cw <= dispW + 0.5) panX = (dispW - cw) / 2 - oxz;
    else { const minX = dispW - cw - oxz, maxX = -oxz; if (panX > maxX) panX = maxX; else if (panX < minX) panX = minX; }
    if (ch <= dispH + 0.5) panY = (dispH - ch) / 2 - oyz;
    else { const minY = dispH - ch - oyz, maxY = -oyz; if (panY > maxY) panY = maxY; else if (panY < minY) panY = minY; }
  }

  // Safari-style zoom-into-the-tapped-field for the whole-page desktop-fit view.
  // At the zoomed-OUT overview a field is tiny; on focus, zoom to a readable level
  // and pan the field to the upper area (above where the keyboard will be). rect
  // is the focused field in remote CSS px. Maps it back through BOTH the noVNC
  // scale and our CSS transform via the live canvas rect, so no layout assumptions.
  function zoomToField(rect) {
    const currentViewport = getCurrentViewport();
    if (!rect || !currentViewport) return;
    const screen = getScreenElement();
    const canvas = screen && screen.querySelector('canvas');
    if (!canvas) return;
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    const Zc = zoomScale, tyc = panY - appliedLift;
    // Canvas geometry in untransformed #screen-local space (undo current transform).
    const clx = (cr.left - panX) / Zc, cly = (cr.top - tyc) / Zc;
    const clw = cr.width / Zc, clh = cr.height / Zc;
    // Field centre → #screen-local coords.
    const flx = clx + (rect.x + rect.w / 2) * (clw / currentViewport.w);
    const fly = cly + (rect.y + rect.h / 2) * (clh / currentViewport.h);
    const dispW = window.innerWidth, dispH = window.innerHeight;
    const Z = Math.min(MAX_ZOOM, Math.max(minZoom * 1.5, getReadableZoom()));
    // We position the field entirely via pan (above the keyboard), so take over
    // from the keyboard lift — applyLift is suppressed while zoomedToField (its
    // no-zoom geometry math would double-shift). Put the field ~28% down, centred.
    appliedLift = 0;
    zoomScale = Z;
    panX = dispW / 2 - flx * Z;
    panY = dispH * 0.30 - fly * Z; // field centre ~30% down — label sits above, field clears the keyboard
    clampPan();
    composeScreenTransform(true);
    onZoomSettled();
    // panX is logged alongside panY because a field can land off-screen HORIZONTALLY
    // on a fit-to-width page (the field is a band in the middle of a 980px layout,
    // not full-bleed as on a responsive one), and panY alone cannot distinguish a
    // bad centring from a bad clamp. flx/vw are the two terms that feed panX.
    dbg('zoom-to-field z=' + Z.toFixed(2) + ' panX=' + Math.round(panX) + ' panY=' + Math.round(panY)
      + ' flx=' + Math.round(flx) + ' vw=' + currentViewport.w
      + ' rect=' + Math.round(rect.x) + ',' + Math.round(rect.w)
      + ' cr=' + Math.round(cr.width) + ' Zc=' + Zc.toFixed(2));
  }

  function beginPinch(e) {
    const ts = e.touches;
    if (!ts || ts.length < 2) return;
    const a = ts[0], b = ts[1];
    const startDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    // Content point currently under the pinch midpoint (in pre-transform px) —
    // keep it anchored under the fingers as they move/spread.
    pinch = { startDist, startScale: zoomScale, cx: (mx - panX) / zoomScale, cy: (my - panY) / zoomScale };
  }
  function updatePinch(e) {
    const ts = e.touches;
    if (!pinch || !ts || ts.length < 2) return;
    const a = ts[0], b = ts[1];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    let s = pinch.startScale * (d / pinch.startDist);
    s = Math.max(minZoom, Math.min(MAX_ZOOM, s));
    zoomScale = s;
    panX = mx - pinch.cx * s;
    panY = my - pinch.cy * s;
    clampPan();
    composeScreenTransform(false);
  }
  function endPinch() {
    pinch = null;
    // Snap cleanly back to the fit floor when the user pinches down near it.
    if (zoomScale < minZoom * 1.06) { zoomScale = minZoom; clampPan(); }
    composeScreenTransform(true);
    onZoomSettled();
    dbgv('pinch end -> zoom=' + zoomScale.toFixed(2) + ' min=' + minZoom.toFixed(2) + ' fit=' + (getFitMode() ? 1 : 0));
  }

  // Zoom IN to the readable level / OUT to the whole-page overview (the floating
  // button's action; also the Escape-key toggle target via the core).
  function toggleMagnify() {
    if (isZoomed()) {
      // Zoom OUT to the whole-page overview.
      zoomScale = minZoom; panX = 0; panY = 0;
    } else {
      // Zoom IN to the readable level, anchored at the top of the page.
      zoomScale = Math.min(MAX_ZOOM, Math.max(minZoom * 1.5, getReadableZoom()));
      panX = 0; panY = 0;
    }
    clampPan();
    composeScreenTransform(true);
    onZoomSettled();
    dbgv('magnify tap -> zoom=' + zoomScale.toFixed(2) + ' min=' + minZoom.toFixed(2) + ' fit=' + (getFitMode() ? 1 : 0));
  }

  function beginPan(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    panning = { x: t.clientX, y: t.clientY, panX0: panX, panY0: panY };
  }
  function updatePan(e) {
    const t = e.touches && e.touches[0];
    if (!panning || !t) return;
    panX = panning.panX0 + (t.clientX - panning.x);
    panY = panning.panY0 + (t.clientY - panning.y);
    clampPan();
    composeScreenTransform(false);
  }

  // visibleBottom = the screen-Y below which the keyboard occludes content.
  function liftAmount(rect, visibleBottom) {
    if (!rect || !isFinite(rect.y) || !isFinite(rect.h)) return 0;
    const screen = getScreenElement();
    const canvas = screen ? screen.querySelector('canvas') : null;
    if (!canvas || !canvas.height) return 0;
    const cr = canvas.getBoundingClientRect();
    // Stream is scaled to fit the canvas, so map remote px -> displayed px by
    // displayed-height / remote-viewport-height. Recover the field's resting
    // position by undoing the CURRENTLY RENDERED transform (not the target lift),
    // so the computation is stable across rapid calls during the transition.
    const currentViewport = getCurrentViewport();
    const refH = (currentViewport && currentViewport.h > 0) ? currentViewport.h : canvas.height;
    const ratioY = cr.height / refH;
    const stableTop = cr.top - currentTranslateY(screen);
    const fieldBottom = stableTop + (rect.y + rect.h) * ratioY;
    const margin = 16;
    const limit = visibleBottom - margin;
    if (fieldBottom > limit) return Math.min(fieldBottom - limit, cr.height);
    return 0;
  }

  function applyLift(visibleBottom) {
    positionMirrorBar(); // keep the visible bar pinned to the keyboard's top edge
    // Zoom-to-field (novp whole-page fit) already positions the field above the
    // keyboard via pan; the lift's no-zoom geometry would double-shift it off-screen.
    if (getZoomedToField()) return;
    // Layout-resize browsers (Firefox Android, WebView adjustResize) already
    // reflowed #screen to the smaller height, so the remote is fully visible —
    // a transform lift would push it partly off-screen. No lift needed there.
    if (getLayoutResizeMode()) return;
    const screen = getScreenElement();
    if (!screen) return;
    const lift = liftAmount(getCurrentRect(), visibleBottom);
    // No-op if unchanged (avoids re-triggering the transition on every scroll
    // tick during the keyboard animation).
    if (Math.round(lift) === Math.round(appliedLift)) return;
    dbgv('lift ' + Math.round(appliedLift) + '->' + Math.round(lift) + ' (vb=' + Math.round(visibleBottom) + ')');
    appliedLift = lift;
    composeScreenTransform(true);
  }

  function clearLift() {
    appliedLift = 0;
    // Ease back down (unless zoomed — a pan/zoom in progress wants no transition).
    composeScreenTransform(zoomScale === 1 && !panning);
  }

  // Where the keyboard's top edge is, from whichever detector is available.
  // Host-supplied geometry first: in an embedded viewer the local reads below can
  // be structurally blind (VK mute without allow="virtual-keyboard", subframe
  // visualViewport that never shrinks), in which case they'd return the full
  // innerHeight — a zero lift, i.e. the focused field left behind the keyboard.
  function currentVisibleBottom() {
    const host = hostGeometry();
    if (host) return host.visibleHeight;
    const vk = navigator.virtualKeyboard;
    if (vk && vk.boundingRect && vk.boundingRect.height > 0) {
      return window.innerHeight - vk.boundingRect.height;
    }
    if (window.visualViewport) return window.visualViewport.height;
    return window.innerHeight;
  }

  // Report our viewport to the embedder so it can position its own chrome above
  // the keyboard. Routed through host-bridge so the targetOrigin follows the
  // configured ?parentOrigin= (falling back to '*' when unconfigured, which is
  // the historical behavior existing embedders rely on).
  function postViewport(visibleHeight, occludedBottom) {
    postToHost('POPCORN_VIEWPORT', { visibleHeight, occludedBottom });
  }

  function isZoomed() { return zoomScale > minZoom * 1.05; }

  // ---- pointer coordinates vs the CSS zoom --------------------------------------
  // Our zoom is a CSS transform on #screen, which noVNC knows nothing about. Its
  // pointer math is (clientX - canvasRect.left) / display.scale — and the rect it
  // measures is the TRANSFORMED one, so at zoom 2.5 every mouse click is reported
  // 2.5x too far right and down. (Our own touch path is unaffected: it maps through
  // remoteViewport/rect.width, where the zoom cancels out.) A real mouse/trackpad
  // is deliberately passed through to noVNC even in touch mode — see tap.js — so
  // this is exactly the "misclick when zoomed" case.
  //
  // Fix at the source: in the capture phase, shadow clientX/clientY with the point
  // that WOULD have been clicked at zoom 1. Deriving it from the live rect means pan
  // needs no special handling (translate is already inside rect.left) and noVNC's own
  // display.scale never has to be read. Shadowing an own property beats
  // re-dispatching a synthetic event: no recursion guard, no lost event properties.
  const ZOOM_FIX_TYPES = ['mousedown', 'mouseup', 'mousemove', 'wheel'];
  function unzoomEvent(e) {
    if (zoomScale === 1) return;                 // untransformed: noVNC is already right
    const screen = getScreenElement();
    const canvas = screen && screen.querySelector && screen.querySelector('canvas');
    if (!canvas || !canvas.getBoundingClientRect) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    try {
      Object.defineProperty(e, 'clientX', { value: r.left + (e.clientX - r.left) / zoomScale, configurable: true });
      Object.defineProperty(e, 'clientY', { value: r.top + (e.clientY - r.top) / zoomScale, configurable: true });
    } catch (_) {} // a non-configurable clientX would mean no fix, not a broken click
  }
  // Deliberately NOT applied to touch events: our own handlers read clientX from
  // those and do their own (zoom-correct) mapping, so patching them would break the
  // path that already works.
  function installPointerZoomFix() {
    ZOOM_FIX_TYPES.forEach((type) => {
      window.addEventListener(type, unzoomEvent, { capture: true });
    });
  }

  return {
    composeScreenTransform, clampPan, zoomToField, toggleMagnify, installPointerZoomFix,
    beginPinch, updatePinch, endPinch, beginPan, updatePan,
    applyLift, clearLift, currentVisibleBottom, postViewport, isZoomed,

    // Accessors/mutators replacing the core's former direct variable touches.
    zoomScale: () => zoomScale,
    minZoom: () => minZoom,
    pinchActive: () => !!pinch,
    panActive: () => !!panning,
    // Silent null-out, NO snap-back: 3-finger handoff to remote multi-touch, and
    // touchcancel (which calls endPinch itself right after).
    clearGesture() { pinch = null; panning = null; },
    clearPinch() { pinch = null; },   // mid-pinch finger lift -> continue as pan
    clearPan() { panning = null; },
    // dismissKeyboard's zoom reset: deliberately does NOT compose — the caller's
    // following clearLift() composes (with its zoom/pan-aware animate choice).
    resetToMinZoom() { zoomScale = minZoom; panX = 0; panY = 0; clampPan(); },
    // Scale-to-fill floor (magnify ?fill=1, see env.FILL). Raise the minimum zoom
    // so the CSS transform upscales the (kiosk-capped, 1:1) framebuffer to fill a
    // window larger than the remote can render. z is the contain ratio the caller
    // computed (window / framebuffer); z<=1 is the normal no-fill 1:1 view. Snaps
    // the current zoom to the new floor ONLY when the user is resting at the fit
    // level, so a resize re-fills without discarding a pinch-zoom. Composing at
    // zoom>1 freezes resizeSession via noteZoomFreeze (the framebuffer stays at the
    // cap while the transform fills) — which is exactly what fill wants.
    setFillFloor(z) {
      const floor = Math.max(1, Math.min(MAX_ZOOM, z || 1));
      const wasAtFloor = zoomScale <= minZoom * 1.05;
      minZoom = floor;
      zoomScale = wasAtFloor ? floor : Math.max(floor, zoomScale);
      clampPan();
      composeScreenTransform(false);
    },
    // enterFit/exitFit: fresh transform baseline with an instant (no-anim) compose.
    resetTransform() { minZoom = 1; zoomScale = 1; panX = 0; panY = 0; composeScreenTransform(false); },
    // enterFit phase-2: snap to a target zoom instantly.
    applyZoomSnap(z) {
      zoomScale = Math.max(minZoom, Math.min(MAX_ZOOM, z));
      panX = 0; panY = 0;
      clampPan();
      composeScreenTransform(false); // snap instantly — no on-load "scaling" animation
      onZoomSettled();
    },
  };
}

export { MAX_ZOOM };
