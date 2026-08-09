// fit.js — mobile viewport magnify + fit-to-width (opt-in via ?magnify=1).
//
// We ask the remote to REFLOW to the phone's own dimensions: resizeSession
// resizes the framebuffer to our viewport (CSS px), and we POST that same size
// to /emulate so CDP renders a real mobile layout at EXACTLY the framebuffer
// size. deviceScaleFactor MUST be 1 here: the framebuffer is CSS-px sized, so
// a DSF>1 would render device pixels WIDER than the framebuffer and clip the
// right edge. (Crispness would need a device-px framebuffer, which costs ~DPR^2
// more bandwidth — the wrong trade on mobile links.)
//
// Fit-to-width: a non-responsive (fixed-width) page overflows the narrow mobile
// viewport, so instead of a cropped slice we render its FULL width and scale it
// to fit (the enterFit framebuffer "dance"). Owns all fit/emulate/cover state +
// the top-document pid/fit-detection block of applySignal (handleTopDocSignal)
// and the reconnect zoom snapshot (snapshotZoomOnSoftDetach).
//
// createFit(deps): vt is the viewport-transform instance; setMagEligible /
// updateControlButtons come from controls; onNavChanged pokes the core's rect
// stickiness (lastNonEmptyRectsAt = 0) on a real navigation.

import { isTouch, FIXEDW, MAGNIFY, FILL, nowMs, siblingPath } from './env.js';
import { dbg } from './diag.js';
import { MAX_ZOOM } from './viewport-transform.js';

const MAG_TARGET = 2.5;   // fallback readable zoom (responsive/normal magnify)
// How much a fit must downscale before the zoom button is worth showing. Measured
// on a 360px phone: the 980 desktop-fallback fit is 2.72x (unreadable without
// zoom), the 412 left-clip fit is 1.14x (already legible). 1.3 sits cleanly
// between them.
const MAG_BUTTON_RATIO = 1.3;
// How much a fit must downscale before tapping a field should ZOOM INTO it. A much
// higher bar than the button, because this fires unprompted on every field:
//
//   980 desktop-fallback  980/390 = 2.51  the overview is unreadable, so zooming
//                                         in is the only way to type -> zoom
//   ?fixedw=560           560/390 = 1.44  readable AS the overview -> no zoom
//   olw left-clip (412)   412/390 = 1.06  readable, and the whole point was to
//                                         bring the clipped EDGE into view, which
//                                         a zoom throws straight back away -> none
//
// This replaces an earlier `!fixedFit()` special case. That keyed on WHICH branch
// produced the fit, so every new narrow fit had to remember to opt out — and the
// olw path did not, which is how tapping a field on Pinterest started zooming.
// Keying on the ratio makes it a property of the geometry instead.
const FIELD_ZOOM_RATIO = 2.0;
const FIT_MAX_W = 1440;   // cap the layout width we ask the remote to render
const FIT_TRIGGER = 1.15; // content must overflow the viewport by >15% to fit
// A page with no viewport meta is laid out by real mobile browsers at a ~980px
// desktop width scaled to fit (NOT reflowed to the device width). We replicate
// that: render it wide and fit-to-width so it looks like the real site does on a
// phone (and the whole page is reachable — its mobile-reflow layout often can't
// be touch-scrolled). This is browser-standard behavior, not a heuristic.
const NO_VIEWPORT_W = 980;
// The reload a resize triggers can land up to ~3s later, so the settle window
// must be longer than that or the reload's pid bump reads as a real nav.
const FIT_SETTLE_MS = 4500;
const FIT_ZOOM_RESTORE_MS = 12000;
// Debounce for rotate/resize before re-fitting: long enough for the browser to
// finish reporting the new viewport (iOS updates innerWidth/innerHeight in steps
// through the rotation animation) and to coalesce a resize+orientationchange pair.
export const ROTATE_SETTLE_MS = 400;

export function createFit({
  getRfb, getScreenElement, getKeyboardActive, vt, setMagEligible, updateControlButtons, onNavChanged,
}) {
  let lastEmulateKey = '';
  let fitMode = false;
  let fitLayoutW = 0;
  let fitLayoutH = 0;
  // The display width fit was last applied at. A rotate changes it, and both
  // fitLayoutH and the pinned #screen size are derived from it, so it's also how
  // we detect "the viewport WIDTH changed" (rotate/window resize) as opposed to
  // "only the height changed" (soft keyboard), which fit must ignore.
  let fitDispW = 0;
  // Default zoom on entering fit: width-fit (a genuinely wide page) opens zoomed-IN
  // readable; the no-viewport-meta desktop-fit opens zoomed-OUT to the whole page
  // (matches how mobile Safari shows such a page).
  let fitWantReadable = true;
  // True while the CURRENT fit is the ?fixedw one (a responsive page that overflowed),
  // as opposed to the 980px no-viewport-meta fallback. Both report wantReadable false,
  // so that flag cannot tell them apart — and they want opposite things from the
  // automatic zoom-into-field (see kbd/field-session.js).
  let fitFixed = false;
  // True until the first top-doc /kbd signal is processed and the fit decision is
  // made. The load cover is held this whole time so a page about to switch to
  // desktop-fit doesn't flash its device-width render first (see revealWhenSettled).
  let fitDecisionPending = true;
  let lastPid = null;

  // Fit changes RESIZE the remote viewport, and some pages reload their TOP frame
  // on a width change — which bumps pid (our nav signal) even though the user
  // didn't navigate. Left unguarded, enter→(reload bumps pid)→exit→(reload)→enter
  // ping-pongs forever and the keyboard never gets a stable frame. Absorb pid
  // churn for a beat after any fit change, and hard-latch if a ping-pong persists.
  let lastFitChangeAt = 0;
  let fitToggleTimes = [];
  let fitLatched = false;
  // Reconnect zoom memory: a soft-detach (auto-reconnect) snapshots the current
  // fit zoom here; a re-fit triggered by the reconnect (the extension's MV3
  // worker can restart → new pid → exit+re-enterFit) restores it instead of
  // snapping back to the readable default. Genuine navigations never soft-detach,
  // so they still get the readable default. Freshness-gated so a stale snapshot
  // can't hijack a real navigation that happens much later.
  let pendingFitZoom = null;
  let pendingFitZoomAt = 0;
  function pendingFitZoomFresh() {
    return pendingFitZoom != null && (nowMs() - pendingFitZoomAt) < FIT_ZOOM_RESTORE_MS;
  }
  // countTowardLatch=false for a reconnect re-application: it still stamps
  // lastFitChangeAt (so a reload the re-emulate triggers is absorbed as churn, not
  // read as a nav) but does NOT feed the ping-pong counter. Otherwise 3 auto-
  // reconnects within 30s on a flaky link would falsely latch fit forever, and a
  // later navigation to a genuinely responsive page could never exitFit — leaving
  // it stuck in the 980px desktop-fit view (unrecoverable without a full reload).
  function noteFitToggle(countTowardLatch = true) {
    const t = nowMs();
    lastFitChangeAt = t;
    if (!countTowardLatch) return;
    fitToggleTimes.push(t);
    fitToggleTimes = fitToggleTimes.filter((x) => t - x < 30000);
    if (fitToggleTimes.length >= 3) { fitLatched = true; dbg('fit latched: resize/nav ping-pong'); }
  }

  // The readable ("actual size") zoom. In fit-to-width the whole page is scaled
  // WAY down, so 1:1 with the page's own CSS pixels = fitLayoutW/viewport (each
  // remote px shown as one display px). Elsewhere fall back to a fixed 2.5x.
  // Parameterized on the display width so a rotate can compare the zoom it had
  // (at the OLD width) against the one it needs (at the new one) — see refitForRotate.
  function readableZoomFor(dispW) {
    if (fitMode && fitLayoutW > 0) {
      return Math.min(MAX_ZOOM, Math.max(1.2, fitLayoutW / Math.max(1, dispW)));
    }
    return MAG_TARGET;
  }
  function readableZoom() { return readableZoomFor(window.innerWidth); }

  // Startup/reflow cover — on load the framebuffer resizes (Xvnc 1920 -> phone
  // size) and the page reflows desktop -> mobile, which is a visible resize glitch
  // in magnify (the stream is shown 1:1, so you briefly see the cropped desktop
  // then it snaps to the mobile layout). Cover with an opaque #111 layer until the
  // framebuffer has settled at the target size, then fade it out — clean load.
  let coverEl = null;
  function showCover() {
    if (coverEl || !MAGNIFY) return;
    try {
      coverEl = document.createElement('div');
      coverEl.id = '__pcn_cover';
      coverEl.style.cssText = 'position:fixed;inset:0;background:#111;z-index:2147483645;' +
        'opacity:1;transition:opacity .2s ease-out;pointer-events:none;';
      (document.body || document.documentElement).appendChild(coverEl);
    } catch (_) {}
  }
  function hideCover() {
    if (!coverEl) return;
    const el = coverEl; coverEl = null;
    try { el.style.opacity = '0'; setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 250); }
    catch (_) { try { el.remove(); } catch (__) {} }
  }
  // Reveal once the framebuffer has reached the target width (don't reveal mid-
  // resize on a slow link); safety-reveal after ~3s regardless. Not used for fit
  // mode — enterFit/phase2 owns the cover there (target width differs).
  function revealWhenSettled(tries) {
    if (!coverEl || fitMode) { if (fitMode) return; hideCover(); return; }
    const t = tries || 0;
    // Hold the cover until the fit decision is made (a no-viewport-meta page is
    // about to switch to desktop-fit — revealing its device-width render first is
    // the "loads one view then refreshes" flash). Once a pid signal is processed we
    // either entered fit (handled above, phase-2 reveals) or confirmed responsive.
    // Poll at 60ms (was 120ms) so the stream reveals ~half a poll sooner once the
    // framebuffer is ready — the cover only needs to outlast the resize, not add
    // its own latency. Safety cap held at ~4.8s (80 * 60ms).
    if (fitDecisionPending && t < 80) { setTimeout(function () { revealWhenSettled(t + 1); }, 60); return; }
    const screen = getScreenElement();
    const c = screen && screen.querySelector('canvas');
    // Reveal once the framebuffer reaches its EXPECTED size — which in scale-to-fill
    // is the proportional target (e.g. 1243), NOT #screen.offsetWidth (the window,
    // 2560). Comparing to the window made the check never match under fill, so the
    // cover sat until the 4.8s safety cap ("fill takes so long to load").
    const dw = (screen && screen.offsetWidth) || window.innerWidth;
    const dh = (screen && screen.offsetHeight) || window.innerHeight;
    const target = (typeof window !== 'undefined' && window.__pcnFbTarget) ? window.__pcnFbTarget(dw, dh).w : dw;
    if (c && c.width > 0 && Math.abs(c.width - target) <= Math.max(6, target * 0.06)) { dbg('boot mag-reveal fb=' + c.width); hideCover(); return; }
    if (t >= 80) { hideCover(); return; }
    setTimeout(function () { revealWhenSettled(t + 1); }, 60);
  }

  // Fit-to-width via a framebuffer "dance": noVNC ties the framebuffer size to
  // getBoundingClientRect(#screen), and scaleViewport downscales the framebuffer
  // to fit #screen. So: (phase 1) size #screen UNTRANSFORMED to the full page so
  // resizeSession grows the framebuffer to capture the whole page; (phase 2) turn
  // resizeSession OFF (freeze the big framebuffer), turn scaleViewport ON, and
  // restore #screen to the viewport — noVNC then scales the whole page down to
  // fit. No CSS transform (it would corrupt noVNC's size math).
  let fitPhase2Timer = null;
  // wantReadable (default true) picks the opening zoom: readable/zoomed-in vs the
  // whole-page overview (see fitWantReadable).
  function enterFit(layoutW, sw, wantReadable, countTowardLatch = true) {
    const dispW = window.innerWidth, dispH = window.innerHeight;
    if (!(dispW > 0 && dispH > 0 && layoutW > dispW)) return;
    fitMode = true;
    // Suspend the kiosk-window framebuffer cap (viewer.js rfb._screenSize) for the
    // duration of the fit dance, which deliberately grows the framebuffer to the
    // whole page before scaleViewport downscales it.
    try { window.__pcnFitActive = true; } catch (_) {}
    fitLayoutW = layoutW;
    fitLayoutH = Math.max(1, Math.round(layoutW * dispH / dispW));
    fitDispW = dispW;
    fitWantReadable = (wantReadable == null) ? true : wantReadable;
    vt.resetTransform(); // fresh baseline; instant compose — ensure NO leftover transform
    // Offer the zoom/fit button only when zooming actually buys something. The
    // button exists for the 980px desktop-fallback fit, whose whole-width view is
    // genuinely unreadable — measured 980/360 = 2.72x on a real phone, so reading
    // anything REQUIRES the zoom. A narrow fit is the opposite case: the Pinterest
    // left-clip fit lands at 412 on the same 360px phone (1.14x), where the
    // whole-width view is already legible and readableZoomFor() falls back to its
    // 1.2 FLOOR rather than anything derived from the fit — so the button toggled
    // 1.00 <-> 1.20, a 20% step that mostly cost sight of the full width on a page
    // whose entire problem was content being cut off at the edge.
    //
    // Pinch-zoom is untouched either way, so nothing becomes unreachable; this only
    // decides whether the floating button earns its slot next to keyboard + paste.
    setMagEligible(layoutW / dispW >= MAG_BUTTON_RATIO); updateControlButtons();
    showCover(); // hide the fit-to-width framebuffer dance
    const s = getScreenElement();
    // Phase 1: grow the framebuffer to the full page size.
    if (s) { s.style.width = fitLayoutW + 'px'; s.style.height = fitLayoutH + 'px'; }
    const rfb = getRfb();
    try { if (rfb) { rfb.scaleViewport = false; rfb.resizeSession = true; } } catch (_) {}
    lastEmulateKey = '';
    noteFitToggle(countTowardLatch);
    pushEmulate(); // emulate fitLayoutW×fitLayoutH (computeEmulation fit branch)
    dbg('fit-to-width p1 layout=' + fitLayoutW + 'x' + fitLayoutH + ' (sw=' + sw + ')');
    // Phase 2: after the server framebuffer has grown, scale it down to fit.
    if (fitPhase2Timer) clearTimeout(fitPhase2Timer);
    fitPhase2Timer = setTimeout(() => {
      fitPhase2Timer = null;
      if (!fitMode) return;
      const rfb2 = getRfb();
      try { if (rfb2) { rfb2.resizeSession = false; rfb2.scaleViewport = true; } } catch (_) {}
      // Pin #screen to a FIXED pixel size (the viewport) rather than 100%. If it
      // were 100%, the soft keyboard resizing the layout viewport would shrink
      // #screen → noVNC's ResizeObserver would recompute scaleViewport from the
      // (zoom-transformed) size → the display would rescale = a visible zoom
      // jump on every keyboard open/close. A fixed size never changes on
      // keyboard, so noVNC's scale stays put; the keyboard just overlays and the
      // lift transform shifts content as usual.
      if (s) { s.style.width = dispW + 'px'; s.style.height = dispH + 'px'; }
      // Default to the READABLE (zoomed-in) view, anchored top-left — the whole-
      // page fit is too small to read on a phone. Button/pinch zooms out to the
      // overview. Let scaleViewport settle a beat first, then apply the zoom.
      setTimeout(() => {
        if (!fitMode) return;
        // Restore the user's pre-reconnect zoom if this re-fit is part of a
        // reconnect; otherwise default to the readable (zoomed-in) view.
        // applyZoomSnap clamps, resets pan, composes instantly (no on-load
        // "scaling" animation) and refreshes the magnify button state.
        vt.applyZoomSnap(pendingFitZoomFresh()
          ? pendingFitZoom
          : (fitWantReadable ? readableZoom() : vt.minZoom()));
        hideCover(); // settled — reveal the readable fit view
        dbg('boot fit-reveal z=' + vt.zoomScale().toFixed(2)); // cold-start timing: cover lifts here (fit path)
        dbg('fit-to-width p2 zoom=' + vt.zoomScale().toFixed(2) + (pendingFitZoomFresh() ? ' (restored)' : ''));
      }, 150);
      dbg('fit-to-width p2 scaleViewport on');
    }, 1000);
  }
  function exitFit() {
    if (fitPhase2Timer) { clearTimeout(fitPhase2Timer); fitPhase2Timer = null; }
    hideCover();
    setMagEligible(false); updateControlButtons(); // responsive page → no magnify button
    fitMode = false; fitLayoutW = 0; fitLayoutH = 0; fitDispW = 0; fitWantReadable = true; fitFixed = false;
    try { window.__pcnFitActive = false; } catch (_) {} // re-arm the framebuffer cap
    vt.resetTransform(); // instant compose; order vs the size reset below is immaterial
    const s = getScreenElement();
    if (s) { s.style.width = ''; s.style.height = ''; }
    const rfb = getRfb();
    try { if (rfb) { rfb.scaleViewport = false; rfb.resizeSession = true; } } catch (_) {}
    lastEmulateKey = '';
    noteFitToggle();
    pushEmulate();
    dbg('fit-to-width exit (nav)');
  }

  // Re-arm fit rendering on a RECONNECT. A fresh RFB comes up at the magnify
  // default (scaleViewport off). Merely flipping rfb.scaleViewport=true proved
  // unreliable — noVNC didn't recompute the scale, so the WIDE fit framebuffer
  // rendered ~1:1 and the CSS zoom compounded on top (the "zoomed in even more,
  // desktop layout gone" report). Instead RE-RUN the proven enterFit dance: it
  // grows/keeps the wide framebuffer and turns scaleViewport back on with a real
  // scale recompute, and its phase-2 restores the pre-reconnect zoom from
  // pendingFitZoom. No-op outside fit mode / on first connect (fit is entered
  // later via the /kbd detector).
  function reapplyFitOnReconnect() {
    if (!fitMode || !getRfb()) return;
    if (fitPhase2Timer) return; // a fit dance is already running — don't stack
    const lw = fitLayoutW, wr = fitWantReadable;
    if (!(lw > 0)) return;
    dbg('fit re-run on reconnect layout=' + lw + ' pending=' + (pendingFitZoomFresh() ? pendingFitZoom.toFixed(2) : 'none'));
    enterFit(lw, lw, wr, false); // reconnect re-apply — must not feed the ping-pong latch
  }

  // Rotation while in fit mode. Fit pins #screen to a FIXED px size and derives
  // fitLayoutH from the display aspect, so a rotate leaves both stale. The old
  // handling was exitFit() + wait for the /kbd detector to re-enter, which lost
  // the user's view twice over: the zoom snapped back to the mode default (the
  // whole-page overview for a no-viewport-meta page, i.e. "the magnify is gone"),
  // and the brief narrow re-render costs a page reload on a reload-on-resize site.
  //
  // Instead re-run the fit dance at the new size and carry the zoom across as a
  // RATIO to readable, not as an absolute number: readable means "one remote px
  // per display px", so it is fitLayoutW/dispW and MUST change when dispW does.
  // Keeping the raw zoomScale through a portrait->landscape rotate would leave the
  // page ~2x too zoomed in. Comparing against readableZoomFor(fitDispW) (the width
  // fit was applied at) rather than a live window read keeps this independent of
  // when the browser updates innerWidth relative to the rotate event.
  function refitForRotate() {
    if (!fitMode || !getRfb()) return;
    if (fitPhase2Timer) return;              // a fit dance is already running
    const lw = fitLayoutW, wr = fitWantReadable, prevW = fitDispW;
    const dispW = window.innerWidth;
    if (!(lw > 0 && dispW > 0)) return;
    // Landscape can be wider than the page we were fitting (tablets, and any page
    // narrower than ~1000px). Fit is then meaningless — drop it and let the
    // detector decide from the new size.
    if (lw <= dispW) { dbg('rotate: viewport now wider than fit layout -> exit'); exitFit(); return; }
    if (prevW > 0) {
      const ratio = vt.zoomScale() / readableZoomFor(prevW);
      // enterFit's phase 2 restores pendingFitZoom when fresh — same channel the
      // reconnect path uses, so the zoom is applied at the one point where
      // scaleViewport has settled. applyZoomSnap clamps it to [minZoom, MAX_ZOOM].
      pendingFitZoom = ratio * readableZoomFor(dispW);
      pendingFitZoomAt = nowMs();
    }
    dbg('rotate re-fit ' + prevW + '->' + dispW + ' layout=' + lw +
      ' zoom=' + vt.zoomScale().toFixed(2) + '->' + (pendingFitZoom == null ? 'default' : pendingFitZoom.toFixed(2)));
    enterFit(lw, lw, wr, false); // like a reconnect re-apply: must not feed the ping-pong latch
  }

  function emulateURL() { return siblingPath('/emulate'); }
  // Emulate at the framebuffer size resizeSession is targeting — the #screen
  // element's own pixel size, which is exactly what noVNC requests via
  // SetDesktopSize. Matching it means the render fills the framebuffer with no
  // clipping and no blank margin. In fit-to-width mode #screen is sized to the
  // full page width (fitLayoutW×fitLayoutH), so this naturally emulates + resizes
  // the framebuffer wide; the CSS transform then scales it down to the viewport.
  // deviceScaleFactor is ALWAYS 1: a fractional DSF only changes reported DPR, it
  // does NOT downscale the raster into the VNC framebuffer (verified — it crops).
  function computeEmulation() {
    if (fitMode && fitLayoutW > 0) {
      // Render the FULL page width; the wide framebuffer is scaled down for
      // display by noVNC's scaleViewport (not a CSS transform — that poisons
      // noVNC's own getBoundingClientRect-based resize math).
      return { width: fitLayoutW, height: fitLayoutH, deviceScaleFactor: 1 };
    }
    const screen = getScreenElement();
    let width = Math.max(1, Math.round((screen && screen.offsetWidth) || window.innerWidth));
    let height = Math.max(1, Math.round((screen && screen.offsetHeight) || window.innerHeight));
    // Emulate at the SAME target rfb._screenSize sizes the framebuffer to (viewer.js
    // __pcnFbTarget): the kiosk-capped size (default), or the window-aspect rect
    // fitted in the cap (?fill=1). Sharing the one function keeps CDP layout ==
    // framebuffer, so the render is never clipped and (in fill) never letterboxed.
    const t = (typeof window !== 'undefined' && window.__pcnFbTarget) ? window.__pcnFbTarget(width, height) : null;
    if (t) { width = t.w; height = t.h; }
    return { width, height, deviceScaleFactor: 1 };
  }
  function pushEmulate() {
    if (!MAGNIFY) return;
    const e = computeEmulation();
    const key = e.width + 'x' + e.height + '@' + e.deviceScaleFactor.toFixed(3);
    if (key === lastEmulateKey) return; // skip redundant POSTs (resize spam)
    lastEmulateKey = key;
    dbg('emulate ' + key);
    try {
      fetch(emulateURL(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // mobile:false is deliberate. mobile:true (a) breaks sizing — Chromium
        // renders the width at ~4x — and (b) desyncs the fingerprint (mobile
        // signals on Fortress's Windows identity). A NARROW viewport already
        // triggers sites' mobile layout via width media queries, and touch makes
        // it a coherent Windows *touch* device (Surface-style) — mobile UX
        // without the mobile-on-desktop contradiction that bot detectors flag.
        body: JSON.stringify({ width: e.width, height: e.height, deviceScaleFactor: e.deviceScaleFactor, mobile: false, touch: isTouch }),
      }).then((r) => { if (!r.ok) lastEmulateKey = ''; })
        .catch(() => { lastEmulateKey = ''; }); // allow retry on failure
    } catch (_) { lastEmulateKey = ''; }
  }

  // Fit-to-width detection (top document only — sw/pid are absent from subframe
  // signals). Verbatim from applySignal's pid block: a navigation (new pid)
  // re-detects from the narrow view; content wider than the viewport (a
  // fixed-width legacy page) switches to rendering the full width scaled to fit.
  // Does the page have content the phone cannot reach? Two independent signals,
  // because neither alone catches the case this mode exists for:
  //
  //   sw  — scrollWidth. Sees overflow to the RIGHT, which is scrollable-to, so it
  //         needs the 15% margin before it is worth a downscale.
  //   ol  — px hanging off the LEFT (content.js leftOverflow). Not scrollable-to at
  //         all: you cannot scroll left of the origin, so ANY of it is clipped
  //         content, and the threshold is just noise rejection.
  //
  // Measured live on Pinterest's login at a 360px viewport: sw=393 against a 414
  // trigger — it reads as "fits" — while 99 elements sat at a negative left with 48px
  // hanging off it. sw alone never fires on the exact page this targets.
  const OL_TRIGGER = 16; // px; below this it is rounding/shadow, not clipped layout
  function overflowsViewport(state) {
    if (state.sw > 0 && state.sw > state.vw * FIT_TRIGGER) return true;
    return typeof state.ol === 'number' && state.ol >= OL_TRIGGER;
  }

  // Fit width for a page whose content is clipped off the LEFT, derived from the
  // clipped content's own width (content.js `olw`) rather than from how far it
  // hangs off (`ol`).
  //
  // ol cannot drive a width because it does not converge: across a width sweep of
  // Pinterest's login it read 34px at 393, 414, 480 and 600 alike, because one 60px
  // decorative element sits permanently at -34. Widening until ol shrinks therefore
  // runs to FIT_MAX_W and re-lays the page out as desktop — the same runaway that
  // fitting to sw produced. olw over that sweep went 392 -> 60 the instant the form
  // fitted, so one measurement gives the answer and the re-measure confirms it.
  //
  // OLW_TRIGGER rejects that decorative residual (measured 60px) while admitting the
  // real form (392px). The margin is what turns "as wide as the content" into "wide
  // enough to see it": 392 * 1.05 = 412, and the sweep showed 393 was already
  // sufficient, so a 5% cushion is comfortable without inviting a desktop layout.
  const OLW_TRIGGER = 80;
  const OLW_MARGIN = 1.05;
  function clippedContentTarget(state) {
    const olw = typeof state.olw === 'number' ? state.olw : 0;
    if (!(olw >= OLW_TRIGGER) || !(state.vw > 0)) return 0;
    const target = Math.min(FIT_MAX_W, Math.ceil(olw * OLW_MARGIN));
    // Deliberately NOT clamped up to the viewport. Content NARROWER than the
    // viewport is clipped by where it was positioned, not by how wide it is, and
    // widening cannot be shown to recover it — so decline rather than pay a
    // downscale on a guess.
    return target > state.vw ? target : 0;
  }

  function handleTopDocSignal(state) {
    if (!(MAGNIFY && typeof state.pid === 'string')) return;
    const navChanged = state.pid !== lastPid;
    lastPid = state.pid;
    // Real navigation → the old page's rects are gone; drop the stickiness so
    // the new page's empty/refreshed rect set takes effect immediately.
    if (navChanged) onNavChanged();
    // The latch describes the PAGE we latched on ("this one reloads when resized"),
    // not the session — but it used to live for the session, because nothing ever
    // cleared it. Load hanyang (980 fit, latches), then navigate to Kaggle, and the
    // hold below kept Kaggle at 980 too: a responsive site rendered as desktop, with
    // no way back short of reloading the viewer. The warning about this is already in
    // noteFitToggle's comment; it just had no code behind it.
    //
    // A pid change arriving FIT_SETTLE_MS after our own last fit change cannot be the
    // reload our resize provoked — that lands within milliseconds. So it is a real
    // navigation: drop the latch and let the new page be judged on its own merits.
    // The toggle history goes too, or the ping-pong counter would re-latch on the
    // very next fit.
    if (fitLatched && navChanged && lastFitChangeAt > 0 && nowMs() - lastFitChangeAt >= FIT_SETTLE_MS) {
      dbg('fit unlatched: real navigation ' + Math.round(nowMs() - lastFitChangeAt) + 'ms after the last fit change');
      fitLatched = false;
      fitToggleTimes = [];
      if (fitMode) exitFit(); // back to the phone width; the next signal re-detects
    } else if (fitLatched) {
      // A reload-on-resize page was detected — HOLD fit and ignore pid churn so
      // the full-width view stays put (any exit would re-emulate and trigger
      // yet another reload → the ping-pong that killed the keyboard/refreshed).
    } else if (lastFitChangeAt > 0 && nowMs() - lastFitChangeAt < FIT_SETTLE_MS) {
      // A pid change THIS soon after our OWN fit resize means the page reloaded
      // BECAUSE of the resize (a reload-on-width-change page), not a user nav.
      // Latch fit so we stop re-emulating; the full-width readable view stays.
      // Gate on lastFitChangeAt>0 so this doesn't fire at STARTUP (when it's 0 and
      // nowMs() is still small) — that delayed the first fit by up to FIT_SETTLE_MS.
      if (navChanged && fitMode) { fitLatched = true; dbg('fit latched: reload-on-resize'); }
    } else if (fitMode) {
      if (navChanged) exitFit();
    } else if (state.novp && state.vw > 0 && window.innerWidth < NO_VIEWPORT_W) {
      // No viewport meta → replicate the browser's ~980px desktop-fallback layout
      // scaled to fit (see NO_VIEWPORT_W). Open ZOOMED OUT (whole page) like mobile
      // Safari shows it; the whole page is reachable and the zoom button reads in.
      //
      // Opening at readableZoom() instead was tried and reverted: it makes the text
      // bigger but no sharper (the framebuffer is CSS-px sized, so at 2.49x every
      // framebuffer pixel covers ~9 device pixels on a DPR-3 phone), and it COSTS
      // the tap-to-zoom affordance — applySignal's zoom-into-field is a no-op when
      // the view already sits at readable zoom, so tapping a field no longer frames
      // it. Blur is a framebuffer-DENSITY problem, not a zoom-level one; fixing it
      // here just traded one complaint for two.
      enterFit(NO_VIEWPORT_W, state.sw || NO_VIEWPORT_W, false);
    } else if (FIXEDW > 0 && state.vw > 0 && overflowsViewport(state)) {
      // A "Pinterest-like" page: RESPONSIVE (it declares width=device-width, so the
      // novp branch above passed it over) yet its content still overflows the phone.
      // That is the fixed-width modal centred for a wider layout — Pinterest's login
      // measured sw=508 against a 360px viewport, with part of it at a NEGATIVE left
      // offset, i.e. unreachable (you cannot scroll left of the origin). Pages that
      // fit stay native 1:1 and crisp; only the overflowing ones pay a downscale.
      //
      // Fits to the CONSTANT width, never to sw — and that is the whole safety
      // property. Fitting to the measurement is what ran away before: re-emulating at
      // sw=1104 made the page lay out as desktop, sw grew to 1236, and the re-layout
      // confirmed the misdiagnosis. A constant cannot escalate no matter how the page
      // re-measures, so the detector is allowed to be crude.
      //
      // Zoomed out (wantReadable false): at this width the whole-width view is
      // readable, which is the entire premise — see the FIXEDW note in env.js.
      enterFit(FIXEDW, state.sw, false);
      fitFixed = fitMode; // enterFit declines if FIXEDW <= the viewport
    } else if (FIXEDW === 0 && state.vw > 0) {
      // Two independent reasons to fit without the flag, and the WIDER target wins
      // — a page can both overflow right and be clipped left, and the smaller fit
      // would leave the other side unreachable.
      //
      // sw: content overflowing to the RIGHT. Scrollable-to, so it needs the 15%
      // margin, and it fits to the measurement — the legacy behaviour, untouched.
      const swTarget = (state.sw > 0 && state.sw > state.vw * FIT_TRIGGER)
        ? Math.min(state.sw, FIT_MAX_W)
        : 0;
      // olw: content clipped off the LEFT, which sw cannot see at all. Pinterest's
      // login measured sw=400 against a 360px viewport — under the 414 trigger, so
      // it read as "fits" — while 68 elements sat at a negative left and the form's
      // own rows were 392px wide. This is the case the ?fixedw flag was added for;
      // deriving the width from olw makes it work without the flag.
      const olTarget = clippedContentTarget(state);
      const target = Math.max(swTarget, olTarget);
      if (target > 0) {
        // A left-clip fit opens zoomed OUT, matching the ?fixedw path: the target is
        // a modest width (412 for Pinterest, i.e. ~0.87 scale on a 360px phone), so
        // the whole-width view is readable AND the clipped edge is actually on
        // screen. This is not the 980px whole-page fit that the readable-by-default
        // rule guards against — that one shrinks text to ~0.37. A right-overflow fit
        // keeps the readable default it has always had.
        enterFit(target, state.sw || target, olTarget > swTarget ? false : undefined);
      }
    }
    // Fit decision made for this top-doc signal — the load cover can now reveal
    // (or, if we entered fit, enterFit's own cover/phase-2 takes over).
    fitDecisionPending = false;
  }

  // Reconnect zoom memory (verbatim from detach's soft path): remember the fit
  // zoom so a reconnect-driven re-fit restores it instead of snapping back to
  // the readable default. On a flapping reconnect (several soft-detaches) the
  // FIRST snapshot wins — a later exitFit could have reset the zoom — but keep
  // refreshing the timestamp so it stays fresh until the reconnect settles.
  function snapshotZoomOnSoftDetach() {
    if (!fitMode) return;
    if (!pendingFitZoomFresh()) pendingFitZoom = vt.zoomScale();
    pendingFitZoomAt = nowMs();
    dbg('reconnect fit snapshot zoom=' + vt.zoomScale().toFixed(2) + ' pending=' + pendingFitZoom.toFixed(2));
  }

  // Magnify runs independently of the keyboard/touch layer so it also works on
  // desktop (?magnify=1). It pushes the CDP emulation and re-pushes when our own
  // dimensions change. Display stays scale-to-fit; magnify only changes what the
  // remote renders (mobile layout at a framebuffer-filling DSF).
  let magnifyStarted = false;
  let pushTimer = null;
  let rotateTimer = null;
  let fillReclampTimer = null; // scale-to-fill: deferred re-clamp after an async fb resize

  // settle: converge to the FINAL size once. Enabling resizeSession triggers a
  // single SetDesktopSize to the current viewport (and leaves it on, stable
  // since the size has settled), then push the matching CDP emulation.
  // Scale-to-fill floor (env.FILL): the contain ratio to upscale the capped
  // framebuffer to fill the window. window/framebuffer, where the framebuffer is
  // min(window, cap) — so it's 1 while the window fits the cap and >1 only past it.
  // Computed from the CAP (not the live canvas) so it's correct without waiting for
  // a framebuffer round-trip.
  function fillFloorFor() {
    if (!(typeof window !== 'undefined' && window.__pcnFbTarget)) return 1;
    const iw = window.innerWidth, ih = window.innerHeight;
    const t = window.__pcnFbTarget(iw, ih); // the framebuffer we're actually rendering into
    if (!t || t.w <= 0 || t.h <= 0) return 1;
    // Upscale the framebuffer to the window. In ?fill=1 the framebuffer already has
    // the WINDOW's aspect (proportional target), so both ratios are equal -> fills
    // edge-to-edge with no letterbox and nothing cropped.
    return Math.max(1, Math.min(iw / t.w, ih / t.h));
  }

  function settle() {
    // In fit-to-width mode the framebuffer is deliberately WIDE (scaleViewport
    // downscales it); re-enabling resizeSession here would shrink it back to the
    // viewport and undo the fit. Leave the resize state to enterFit/exitFit.
    if (fitMode) { pushEmulate(); return; }
    const rfb = getRfb();
    if (FILL) {
      // Scale-to-fill converges in one deterministic order for both grow and shrink:
      //   1. drop any fill zoom to 1 so #screen's rect is UN-inflated (the capped
      //      resize request below reads getBoundingClientRect(#screen), which
      //      includes our transform) — this also unfreezes resizeSession;
      //   2. resizeSession sizes the framebuffer to min(window, cap);
      //   3. re-apply the fill floor — >1 re-freezes (framebuffer stays at the cap,
      //      the transform fills the window), ==1 leaves the plain 1:1 view.
      // setZoomFreeze is guarded to NOT call settle() under FILL, so this can't recurse.
      vt.setFillFloor(1);
      try { if (rfb) rfb.resizeSession = true; } catch (_) {}
      pushEmulate();
      vt.setFillFloor(fillFloorFor());
      // The framebuffer resize above is async (a SetDesktopSize round-trip), so
      // clampPan just measured the OLD canvas. Re-apply once it lands, or a shrink
      // leaves the view panned by a stale offset. Cheap (setFillFloor is idempotent).
      if (fillReclampTimer) clearTimeout(fillReclampTimer);
      fillReclampTimer = setTimeout(() => {
        fillReclampTimer = null;
        if (!fitMode && FILL) vt.setFillFloor(fillFloorFor());
      }, 320);
      return;
    }
    if (zoomFrozen) { pushEmulate(); return; } // zoomed: see setZoomFreeze
    try { if (rfb) rfb.resizeSession = true; } catch (_) {}
    pushEmulate();
  }

  // A CSS zoom must FREEZE the remote framebuffer size.
  //
  // noVNC derives the size it requests from getBoundingClientRect(#screen) — which
  // includes our transform. So with resizeSession on, zooming to 2.5x makes noVNC
  // ask the server for a framebuffer 2.5x larger, while pushEmulate sizes the CDP
  // viewport from screen.offsetWidth (transform-independent). The page then paints
  // its small viewport into the top-left of a huge framebuffer and the rest is
  // blank — the "zoom collapses the layout" bug.
  //
  // Fit mode was immune by accident (phase 2 turns resizeSession off to hold the
  // wide framebuffer), which is why only RESPONSIVE pages showed this.
  let zoomFrozen = false;
  function setZoomFreeze(on) {
    if (zoomFrozen === on) return;
    zoomFrozen = on;
    dbg('zoom freeze ' + (on ? 'on' : 'off') + (fitMode ? ' (fit: no-op)' : ''));
    if (fitMode) return;              // fit already owns resizeSession
    const rfb = getRfb();
    if (on) { try { if (rfb) rfb.resizeSession = false; } catch (_) {} return; }
    // Back to 1:1 — re-enable and re-push, since the framebuffer may have drifted
    // from the viewport while frozen (a rotate or keyboard resize mid-zoom).
    lastEmulateKey = '';
    // Under scale-to-fill, settle() OWNS the resizeSession + fill-floor sequence and
    // calls setFillFloor (which composes → can re-enter here). Returning breaks that
    // recursion; settle re-enables resizeSession itself.
    if (FILL) return;
    settle();
  }

  function startMagnify() {
    if (magnifyStarted) return;
    magnifyStarted = true;
    showCover(); // hide the load-time resize churn until the framebuffer settles
    // During an active resize burst (drag to a bigger window, rotate) FREEZE the
    // remote size — resizeSession off so noVNC doesn't realloc the framebuffer
    // ~10x/sec and thrash the encoder (the "jitter like crash"). Resize once when
    // it settles. Keyboard-driven viewport shrink is not a real resize.
    const onResize = () => {
      if (fitMode) {
        // Fit owns the remote resize state (see settle), but it must react to a
        // viewport WIDTH change — that's a rotate (or a desktop window resize /
        // devtools responsive-mode flip, where orientationchange never fires) and
        // it invalidates the pinned #screen size. A height-only change is the soft
        // keyboard, which fit deliberately ignores.
        if (window.innerWidth === fitDispW) return;
        if (rotateTimer) clearTimeout(rotateTimer);
        rotateTimer = setTimeout(() => { rotateTimer = null; refitForRotate(); }, ROTATE_SETTLE_MS);
        return;
      }
      const rfb = getRfb();
      try { if (rfb) rfb.resizeSession = false; } catch (_) {}
      if (pushTimer) clearTimeout(pushTimer);
      if (getKeyboardActive()) return;
      pushTimer = setTimeout(() => { pushTimer = null; settle(); }, 350);
    };
    // Settle now, with retries in case CDP/SetDesktopSize isn't ready at connect.
    settle();
    revealWhenSettled(); // fade the cover once the framebuffer reaches phone size
    setTimeout(settle, 800);
    setTimeout(settle, 2500);
    window.addEventListener('resize', onResize, { passive: true });
    // orientationchange can fire BEFORE the browser has updated innerWidth, and on
    // some browsers doesn't fire at all — so it and resize both funnel into the same
    // debounced handler, which reads the size only once it has settled. Whichever
    // arrives first arms the timer; the other just re-arms it.
    window.addEventListener('orientationchange', () => {
      if (fitMode) {
        if (rotateTimer) clearTimeout(rotateTimer);
        rotateTimer = setTimeout(() => { rotateTimer = null; refitForRotate(); }, ROTATE_SETTLE_MS);
        return;
      }
      setTimeout(settle, ROTATE_SETTLE_MS);
    }, { passive: true });
    setTimeout(() => {
      const screen = getScreenElement();
      const c = screen && screen.querySelector('canvas');
      if (c) { const r = c.getBoundingClientRect(); dbg('canvas ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' win=' + window.innerWidth + 'x' + window.innerHeight); }
    }, 3000);
  }

  return {
    enterFit, exitFit, reapplyFitOnReconnect, refitForRotate, pushEmulate, readableZoom,
    setZoomFreeze,
    startMagnify, handleTopDocSignal, snapshotZoomOnSoftDetach,
    fitMode: () => fitMode,
    wantReadable: () => fitWantReadable,
    fixedFit: () => fitFixed,
    // Should tapping a field zoom into it? True only for a fit whose whole-width
    // overview is genuinely unreadable — see FIELD_ZOOM_RATIO.
    fieldZoomWorthwhile: () => fitMode && fitDispW > 0 && (fitLayoutW / fitDispW) >= FIELD_ZOOM_RATIO,
  };
}
