// viewport-transform.js — the #screen CSS transform: pinch-zoom, pan, and the
// keyboard field-lift, composed in one place.
//
// Viewer-side pinch is the fallback when the native touch channel is unavailable.
// With that channel connected, ordinary two-finger gestures are forwarded to the
// remote website so maps, canvases, and touch handlers receive native multi-touch.
// The local path scales/translates #screen instantly; getBoundingClientRect() on
// the canvas reflects the transform, so screen->remote tap mapping remains valid.
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
// Keep #screen on its own GPU layer only WHILE it's transforming. Left on
// permanently, will-change:transform wastes GPU memory for a full-page layer,
// so a debounced timer drops it this long after the last transform write (past
// the 0.15s settle transition).
const LAYER_IDLE_MS = 200;

export function createViewportTransform({
  getScreenElement, getCurrentRect, getCurrentViewport, getLayoutResizeMode,
  getZoomedToField, positionMirrorBar, getReadableZoom, onZoomSettled, getFitMode,
  onZoomFreeze, onTransform,
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

  // How many local px the keyboard OVERLAYS without the layout having reflowed —
  // the pan-range extension budget (see clampPan). Captured in postViewport,
  // which is already the single funnel every detector pushes its authoritative
  // (visibleHeight, occludedBottom) pair through — including 0 on the
  // layout-resize and floating-keyboard paths — so no detector can feed the pan
  // a different occlusion than it reports to the host. Zeroed in clearLift,
  // because some teardowns (dismissKeyboard, onSystemBlur) never post a
  // viewport update; without that, a stale inset would leave the view panned
  // over a dead #111 strip until the next detector event.
  let kbdInset = 0;
  // Read at CLAMP time, not capture time: layoutResizeMode can latch after a
  // host geometry post (the both-shrink WebView case, where the host sees an
  // occlusion but the local layout also reflowed) — the layout has already made
  // room, so any pan extension there would run into blank space below the
  // framebuffer.
  // layoutResizeMode means our own layout made room for the keyboard — which only helps when
  // the framebuffer shrank with it. An embedded viewer keeps the pre-keyboard framebuffer, so
  // the stream (and the focused field) stay behind the keys until we lift/pan after all.
  function framebufferFitsWindow() {
    const screen = getScreenElement();
    const canvas = screen ? screen.querySelector('canvas') : null;
    // The untransformed box the stream occupies, same sources the clamp reads.
    const fbCss = (canvas && (canvas.offsetHeight || canvas.clientHeight)) || 0;
    if (!fbCss) return true;
    return fbCss <= (window.innerHeight || 0) + 4; // slack: fractional dpr rounding
  }

  // The pan EXTENSION stays off in layout-resize mode: the window itself shrank, so the canvas
  // already overflows it and clampPan lets a finger reach that strip — an inset on top would
  // double-count it and pan into blank space. Only the LIFT needs the framebuffer check.
  function effKbdInset() {
    return getLayoutResizeMode() ? 0 : kbdInset;
  }

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
    if (onTransform) onTransform();
    restoreCanvasInterpolation();
    // Any zoom away from 1:1 must freeze the remote framebuffer size, because
    // noVNC sizes it from this element's (now transformed) bounding rect. Reported
    // from the single transform writer so no zoom path can forget to.
    noteZoomFreeze(zoomScale > 1.01);
    promoteLayer(screen);
  }

  // Fit and fill scale the canvas by non-integer factors, where
  // nearest-neighbour turns the whole remote desktop blocky — so keep the
  // browser's own interpolation. Stream sharpness is the RFB encoding's job
  // (kbd/quality.js), not the compositor's.
  function restoreCanvasInterpolation() {
    const screen = getScreenElement();
    const canvas = screen && screen.querySelector && screen.querySelector('canvas');
    if (!canvas) return;
    if (canvas.style.imageRendering !== 'auto') canvas.style.imageRendering = 'auto';
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
    // While an overlay keyboard is up (inset > 0), the pan range extends DOWN by
    // the part of the occlusion the field-lift hasn't already revealed: the
    // composed translate (panY - appliedLift) may bring the content bottom up to
    // the keyboard's top edge (dispH - inset) but no further. This is the local
    // analogue of a native browser letting the page scroll an extra keyboard-
    // height — the remote's own scroll range was computed for the no-keyboard
    // viewport and runs out with the last screenful still behind the keys, and
    // resizing the remote instead is the re-emulate ping-pong fit.js avoids.
    // inset === 0 keeps both branches byte-identical to the historical clamp.
    const inset = effKbdInset();
    if (ch <= dispH + 0.5) {
      const centre = (dispH - ch) / 2 - oyz;
      // Only the viewport-SIZED framebuffer earns the extension. A genuinely
      // LETTERBOXED canvas (smaller than the display, flex-centered by noVNC
      // inside #screen) has blank #111 below it already, so there is nothing
      // behind the keys to reach — and extending there is actively wrong: the
      // clamp band would become entirely POSITIVE (centre > dispH-ch-inset),
      // so the first drag-up would snap the view DOWN by the whole centring
      // offset, on top of a flex centring that offY does not compensate outside
      // fill mode. Requiring the content to fill the display keeps the
      // extension to the case it was designed for.
      const fillsDisplay = ch >= dispH - 1;
      if (inset > 0 && fillsDisplay) {
        // Content fits the display (the zoom-1 viewport-sized framebuffer):
        // instead of pinning to centre, allow panning up until the content
        // bottom meets the keyboard top. min() degrades to the pin when the
        // content already sits fully above the keys.
        const minY = Math.min(centre, dispH - ch - oyz - inset + appliedLift);
        if (panY > centre) panY = centre; else if (panY < minY) panY = minY;
      } else {
        panY = centre;
      }
    } else {
      const ext = inset > 0 ? Math.max(0, inset - appliedLift) : 0;
      const minY = dispH - ch - oyz - ext, maxY = -oyz;
      if (panY > maxY) panY = maxY; else if (panY < minY) panY = minY;
    }
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
    cancelFling();
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
    cancelFling(); // grabbing again cancels any in-flight glide
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
    // A field scrolled BELOW the remote viewport is not in the framebuffer — no
    // lift can reveal it, only chase it. The extension reports rects unclipped
    // (a below-fold editable ships with y > vh), and scrolling the remote while
    // its field stays focused re-feeds that growing y through every /kbd frame:
    // observed live as lift 257->479->633->640 on a 689px canvas (vb pinned at
    // 406), i.e. the whole stream shoved off the top — a black screen. Stand
    // down until the field scrolls back into the framebuffer.
    if (rect.y >= refH) return 0;
    // panY is added back: stableTop undid the WHOLE rendered translate (pan AND
    // lift), but the lift should only make up what the user's pan hasn't already
    // revealed. While the pan was structurally 0 at zoom 1 this was moot; with
    // the keyboard pan extension a user can pre-reveal the field, and lifting
    // from the unpanned position on top of that over-shifts — content bottom
    // rises past the keyboard's top edge and a dead #111 strip shows above the
    // keys.
    const fieldBottom = stableTop + panY + Math.min(rect.y + rect.h, refH) * ratioY;
    const margin = 16;
    const limit = visibleBottom - margin;
    // Cap at the occlusion, not the canvas: lifting past the keyboard's own
    // height never helps (the field would land above where the keys even
    // start), and clampPan's pan budget (inset - appliedLift) assumes the lift
    // respects this bound. For an on-viewport field the arithmetic already
    // stays under it — the cap only bites the pathological geometries above.
    const inset = Math.max(0, window.innerHeight - visibleBottom);
    if (fieldBottom > limit) return Math.min(fieldBottom - limit, inset + margin, cr.height);
    return 0;
  }

  function applyLift(visibleBottom) {
    positionMirrorBar(); // keep the visible bar pinned to the keyboard's top edge
    // Zoom-to-field (novp whole-page fit) already positions the field above the
    // keyboard via pan; the lift's no-zoom geometry would double-shift it off-screen.
    if (getZoomedToField()) return;
    // Layout-resize browsers (Firefox Android, WebView adjustResize) reflowed #screen ITSELF to
    // the smaller height, so translating it up only exposes background — see revealFocusedRemote.
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

  // Inertial glide for a released keyboard-pan (kbd/tap.js hands us the finger's
  // exit velocity). A finger-tracked pan that stops dead on lift feels un-native;
  // this coasts panY with a constant deceleration, re-clamping every frame so it
  // rests exactly at the budget edge instead of overshooting into blank space.
  // Velocity is px/ms (screen space == panY space at zoom 1). Cancelled by any
  // new gesture or a keyboard teardown so it never fights the user or a dismiss.
  let flingRAF = null;
  const FLING_DECEL = 0.004;   // px/ms^2 — ~stops within a few hundred ms
  const FLING_MIN_V = 0.04;    // px/ms — below this a release is "no flick"
  function cancelFling() {
    if (flingRAF != null) { (window.cancelAnimationFrame || (() => {}))(flingRAF); flingRAF = null; }
  }
  function flingPanY(vy) {
    cancelFling();
    let v = Math.max(-4, Math.min(4, vy || 0));
    if (Math.abs(v) < FLING_MIN_V) return; // a slow release just stays put
    let last = nowMs();
    let frames = 0;
    const step = () => {
      flingRAF = null;
      const now = nowMs();
      let dt = now - last; last = now;
      if (!(dt > 0)) dt = 16;      // frozen clock (tests) — nominal frame
      if (dt > 32) dt = 32;        // a long stall shouldn't teleport the view
      const target = panY + v * dt;
      panY = target;
      clampPan();
      composeScreenTransform(false);
      const hitEdge = panY !== target; // clamp pulled it back → at the budget edge
      const dv = FLING_DECEL * dt;
      v = Math.abs(v) > dv ? v - Math.sign(v) * dv : 0;
      if (hitEdge || Math.abs(v) < 0.02 || ++frames > 180) return;
      flingRAF = (window.requestAnimationFrame || ((fn) => setTimeout(fn, 16)))(step);
    };
    flingRAF = (window.requestAnimationFrame || ((fn) => setTimeout(fn, 16)))(step);
  }

  function clearLift() {
    cancelFling(); // a dismiss mid-glide must not keep coasting
    appliedLift = 0;
    // Every keyboard teardown funnels through here (including the ones that
    // never post a viewport update, like dismissKeyboard and onSystemBlur), so
    // this is where the pan-range extension collapses: drop the inset and
    // re-clamp, which pulls the view out of the now-keyboard-free strip while
    // leaving any legitimate zoom/pan exactly where the user left it
    // (dismissKeyboard's keep-your-place contract). Re-clamp ONLY when the pan
    // actually sits in the extended strip (inset was up and panY is negative):
    // an unconditional clampPan here would be the first-ever at-rest clamp in
    // letterboxed states (canvas smaller than the display, flex-centered by
    // noVNC inside #screen), where the centering branch writes a positive panY
    // on top of that flex centering and shoves the canvas down over the #111
    // background.
    const contract = kbdInset > 0 && panY < 0;
    kbdInset = 0;
    if (contract) clampPan();
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
    // Capture the occlusion as the pan-extension budget (see kbdInset). The
    // wire message is unchanged — hosts keep reading the same numbers.
    kbdInset = (isFinite(occludedBottom) && occludedBottom > 0) ? occludedBottom : 0;
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
  // noVNC has used both MouseEvent and PointerEvent input paths across releases
  // and browsers. Correct both before its listeners run; leaving pointer events
  // out makes clicks miss entirely whenever fit/fill applies a CSS scale.
  const ZOOM_FIX_TYPES = [
    'mousedown', 'mouseup', 'mousemove', 'wheel',
    'pointerdown', 'pointerup', 'pointermove',
  ];
  function unzoomEvent(e) {
    const screen = getScreenElement();
    const canvas = screen && screen.querySelector && screen.querySelector('canvas');
    if (!canvas || !canvas.getBoundingClientRect) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Do not rely on zoomScale here. Moving the viewer between displays can
    // change the compositor's rendered canvas size before the fit state has
    // recalculated, leaving zoomScale at 1 while the canvas is still enlarged.
    // The layout-to-rendered ratio is the authoritative transform correction.
    const sx = canvas.clientWidth > 0 ? canvas.clientWidth / r.width : 1;
    const sy = canvas.clientHeight > 0 ? canvas.clientHeight / r.height : 1;
    try {
      // tap.js sends its own RFB click for physical pointers in magnify mode.
      // It must receive the physical coordinate, not this noVNC-only corrected
      // value, or its transform-aware mapping would undo the scale twice.
      Object.defineProperty(e, '__pcnRawClientX', { value: e.clientX, configurable: true });
      Object.defineProperty(e, '__pcnRawClientY', { value: e.clientY, configurable: true });
      Object.defineProperty(e, 'clientX', { value: r.left + (e.clientX - r.left) * sx, configurable: true });
      Object.defineProperty(e, 'clientY', { value: r.top + (e.clientY - r.top) * sy, configurable: true });
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
    applyLift, clearLift, currentVisibleBottom, postViewport, isZoomed, framebufferFitsWindow,

    // Accessors/mutators replacing the core's former direct variable touches.
    zoomScale: () => zoomScale,
    minZoom: () => minZoom,
    // Keyboard-pan gesture reads (kbd/tap.js): the live pan for its
    // desired-vs-actual handoff math, and the effective occlusion budget that
    // gates the gesture (0 with no keyboard, a floating keyboard, or in
    // layout-resize mode — every state where there is nothing hidden to reach).
    panX: () => panX,
    panY: () => panY,
    kbdPanInset: () => effKbdInset(),
    // Inertial glide for a released keyboard-pan (tap.js supplies exit velocity).
    flingPanY, cancelFling,
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
