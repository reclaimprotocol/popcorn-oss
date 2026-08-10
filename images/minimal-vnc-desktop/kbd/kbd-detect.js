// kbd-detect.js — soft-keyboard visibility detectors.
//
// Three complementary detectors, installed by setupKeyboardDetection():
//   * VirtualKeyboard API geometrychange (Chromium/Android — authoritative when
//     it fires; overlaysContent stops the browser resizing our layout);
//   * visualViewport resize/scroll (iOS Safari and VK-less Chromium);
//   * layout-viewport resize (Firefox Android / adjustResize WebView, where
//     innerHeight shrinks WITH visualViewport so neither of the above fires).
// The vkSeen latch and the VV-delta guard keep them from double-driving.
//
// The detectors DRIVE the core keyboard state — createKbdDetect(deps) receives
// get/set for keyboardActive (setter injection, clipboard.js precedent), the
// flagJustDismissed helper (the `keyboardJustDismissed = true; setTimeout(false)`
// grace pattern), and the vt lift/postViewport verbs. layoutResizeMode is owned
// here (read by vt's applyLift via accessor; reset by dismissKeyboard).

import { isAndroid, nowMs } from './env.js';
import { dbg } from './diag.js';
import { hostGeometryActive } from './host-bridge.js';

export function createKbdDetect({
  getKeyboardActive, setKeyboardActive, getKeyboardOpening, getProxy,
  applyLift, clearLift, postViewport, currentVisibleBottom,
  hideMirrorBar, startWatchdog, flagJustDismissed, getLastInputAt,
}) {
  let lastViewportShrink = false;
  let hostSawOccluded = false;  // host geometry has reported a real occlusion for THIS keyboard
  let vkSeen = false;           // VirtualKeyboard geometrychange has fired for real
  let layoutResizeMode = false; // Firefox Android / WebView: layout viewport resizes for the kbd
  let baselineInnerHeight = (typeof window !== 'undefined' && window.innerHeight) || 0;

  // HOST-SUPPLIED geometry (embedded viewer) — the highest-priority detector.
  //
  // A cross-origin iframe may have no usable keyboard rect of its own: VK stays
  // mute without allow="virtual-keyboard", and a subframe's visualViewport does
  // not reliably shrink. When an embedder that CAN measure posts the rect in
  // (see host-bridge.js), it is authoritative and every local detector stands
  // down — hostGeometryActive() guards them. That exclusivity is deliberate:
  // two detectors driving the lift with slightly different heights is exactly
  // the keyboard-open jitter fixed in e3ddeb5, so this must SUPPRESS the others,
  // never race them. If the host stops posting, its samples age out (8s) and the
  // local detectors resume automatically, so a dead embedder degrades to today's
  // behavior instead of freezing the lift.
  //
  // Mirrors the VK geometrychange branch below, including the h=0 floating/split
  // keyboard case (recent proxy input means "became non-occluding", not
  // "dismissed"), so the two authoritative paths behave identically.
  function handleHostGeometry(g) {
    const visible = g.visibleHeight;
    const occluded = g.occludedBottom;
    if (occluded > 0) {
      hostSawOccluded = true;
      if (!getKeyboardActive()) dbg('host geom occ=' + Math.round(occluded) + ' -> kbd=true');
      setKeyboardActive(true);
      startWatchdog(); // a lost /kbd dismiss on a lossy link must still force teardown
      applyLift(visible);
      postViewport(visible, occluded);
      return;
    }
    if (!getKeyboardActive()) return;
    // occluded == 0 is NOT automatically a dismissal here, and this is the key
    // difference from the VK branch below. VK's geometrychange only fires when the
    // keyboard actually changes, so h=0 there really means "it went away". A host
    // feed is different: it posts on every viewport change AND on a heartbeat, so
    // it reports occluded=0 continuously whenever no keyboard is up — including in
    // the window right after a raise, before the keys have animated in. Acting on
    // those samples tore the keyboard down ~450ms after every raise (observed:
    // "raiseKeyboard(re-raise)" -> "host geom occ=0 -> kbd=false"), which read on
    // device as "the keyboard closes and I have to tap the field twice".
    //
    // So require positive evidence before believing a dismissal: the keyboard must
    // not be mid-open, and the host must have SEEN this keyboard occlude something
    // (hostSawOccluded, the analogue of the VV detector's lastViewportShrink).
    if (getKeyboardOpening()) { dbg('host geom occ=0 ignored (opening)'); return; }
    if (!hostSawOccluded) return; // never occluded -> nothing to dismiss
    if (nowMs() - getLastInputAt() < 1000) {
      dbg('host geom occ=0 but recent input -> keep kbd (floating)');
      clearLift();
      postViewport(visible, 0);
      return;
    }
    dbg('host geom occ=0 -> kbd=false');
    hostSawOccluded = false; // next keyboard must prove itself again
    setKeyboardActive(false);
    clearLift();
    hideMirrorBar(); // keyboardActive already false, so onProxyBlur won't do it
    flagJustDismissed(100);
    const proxy = getProxy();
    if (proxy) proxy.blur();
    postViewport(visible, 0);
  }

  function handleViewportResize() {
    if (!window.visualViewport) return;
    if (hostGeometryActive()) return; // the embedder measures for us — stand down
    if (vkSeen) return; // the VirtualKeyboard API is live and authoritative here
    const viewportHeight = window.visualViewport.height;
    const windowHeight = window.innerHeight;
    const shrunk = (windowHeight - viewportHeight) > 50;

    if (shrunk) {
      if (!getKeyboardActive()) dbg('VP shrunk -> kbd=true (h=' + Math.round(viewportHeight) + ')');
      lastViewportShrink = true;
      setKeyboardActive(true);
      startWatchdog(); // a lost /kbd dismiss on a lossy link must still force teardown
      applyLift(viewportHeight);
      postViewport(viewportHeight, windowHeight - viewportHeight);
      return;
    }

    if (!lastViewportShrink) return;
    lastViewportShrink = false;
    if (getKeyboardOpening()) return; // iOS transient restore mid-open

    // iOS: if the proxy is still focused the keyboard is really still up.
    // Android: back/swipe-down hides the IME WITHOUT blurring, so a confirmed
    // grow IS the dismissal — don't trust the focus guard there.
    const proxy = getProxy();
    const proxyStillFocused = document.activeElement === proxy;
    const focusGuard = isAndroid ? false : proxyStillFocused;
    if (Math.abs(viewportHeight - windowHeight) < 50 && getKeyboardActive() && !focusGuard) {
      // Floating/split keyboard just went non-occluding but is still up — recent
      // proxy input proves it; keep the keyboard, only drop the lift.
      if (nowMs() - getLastInputAt() < 1000) { clearLift(); postViewport(viewportHeight, 0); return; }
      dbg('VP grew -> kbd=false (dismiss)');
      setKeyboardActive(false);
      clearLift();
      hideMirrorBar(); // keyboardActive already false, so onProxyBlur won't do it
      try { window.scrollTo(0, 0); } catch (_) {}
      flagJustDismissed(100);
      if (proxy) proxy.blur();
      postViewport(viewportHeight, 0);
    }
  }

  // iOS fires visualViewport 'scroll' as the keyboard animates and when the
  // page auto-scrolls to the focused input — re-apply the lift so the field
  // stays clear of the keyboard.
  function handleViewportScroll() {
    if (hostGeometryActive()) return; // host geometry owns the lift
    if (vkSeen) return; // VK owns the lift when it's live (see handleViewportResize)
    if (getKeyboardActive()) applyLift(currentVisibleBottom());
  }

  // Fallback detector for browsers that resize the LAYOUT viewport (window.
  // innerHeight) for the keyboard instead of the VISUAL viewport: Firefox Android
  // and Android WebView with adjustResize. There, innerHeight and
  // visualViewport.height shrink TOGETHER, so handleViewportResize's `shrunk`
  // test never fires and (with no VirtualKeyboard API on Firefox) the keyboard
  // state — and the Android back-button dismiss — is invisible, wedging
  // keyboardActive permanently. This watches innerHeight vs a learned baseline.
  function handleLayoutResize() {
    if (hostGeometryActive()) return; // host geometry owns the state
    // Chrome/iOS resize the VISUAL viewport, so a real VV delta means another
    // detector owns this — stay dormant to avoid double-driving the state.
    if (window.visualViewport && (window.innerHeight - window.visualViewport.height) > 50) return;
    const h = window.innerHeight;
    if (!getKeyboardActive() && !getKeyboardOpening()) {
      // Learn the no-keyboard baseline; also absorbs rotation/window resizes.
      if (h > baselineInnerHeight) baselineInnerHeight = h;
    }
    const shrunk = (baselineInnerHeight - h) > 150;
    // A keyboard resize only happens while our proxy holds focus. Foldable/split
    // posture changes also shrink innerHeight but do NOT focus the proxy, so this
    // gate keeps them from being misread as a keyboard.
    const proxy = getProxy();
    const focused = document.activeElement === proxy;
    if (shrunk && focused) {
      if (!getKeyboardActive()) dbg('layout-resize -> kbd=true (h=' + h + ')');
      setKeyboardActive(true);
      layoutResizeMode = true;
      startWatchdog();
      clearLift();                 // layout already reflowed; no transform lift
      postViewport(h, 0);
    } else if (getKeyboardActive() && layoutResizeMode && !shrunk) {
      dbg('layout-resize grew -> kbd=false (dismiss)');
      setKeyboardActive(false);
      layoutResizeMode = false;
      clearLift();
      flagJustDismissed(100);
      if (proxy) proxy.blur();
      baselineInnerHeight = h;
      postViewport(h, 0);
    }
  }

  // Prefer the VirtualKeyboard API (Chromium/Android): visualViewport 'resize'
  // is unreliable on some Android browsers (Brave, certain Samsung firmwares),
  // whereas geometrychange reports the keyboard rect explicitly. overlaysContent
  // stops the browser resizing our layout so we own the lift. iOS Safari lacks
  // this API and uses the visualViewport path below.
  function setupKeyboardDetection() {
    const vk = navigator.virtualKeyboard;
    if (vk) {
      try { vk.overlaysContent = true; } catch (_) {}
      vk.addEventListener('geometrychange', () => {
        if (hostGeometryActive()) return; // host geometry outranks even a live VK
        const h = vk.boundingRect ? vk.boundingRect.height : 0;
        if (h > 0) {
          // First real geometry proves the API works here — latch so the VV
          // fallback (installed below) stays dormant and can't double-drive.
          vkSeen = true;
          if (!getKeyboardActive()) dbg('VK geom h=' + Math.round(h) + ' -> kbd=true');
          setKeyboardActive(true);
          startWatchdog(); // a lost /kbd dismiss on a lossy link must still force teardown
          applyLift(window.innerHeight - h);
          postViewport(window.innerHeight - h, h);
        } else if (getKeyboardActive()) {
          // Floating/split keyboard: h=0 with fresh proxy input means "became
          // non-occluding", NOT dismissed — keep the keyboard, just drop the lift.
          if (nowMs() - getLastInputAt() < 1000) {
            dbg('VK geom h=0 but recent input -> keep kbd (floating)');
            clearLift();
            postViewport(window.innerHeight, 0);
            return;
          }
          dbg('VK geom h=0 -> kbd=false');
          setKeyboardActive(false);
          clearLift();
          flagJustDismissed(100);
          const proxy = getProxy();
          if (proxy) proxy.blur();
          postViewport(window.innerHeight, 0);
        }
      });
      // A TOP-LEVEL tab always has a working VirtualKeyboard API, so VK is the
      // sole authority — do NOT also install the visualViewport fallback, or the
      // two detectors fire together during the open with slightly different
      // heights (innerHeight-vkHeight vs visualViewport.height) and the lift
      // transform bounces between them (jitter). Return here for the common case.
      //
      // Only in a cross-origin portal iframe can VK be mute: geometrychange never
      // fires unless the embedding <iframe> carries allow="virtual-keyboard". For
      // that case only, fall through and ALSO install the VV + layout detectors;
      // the vkSeen latch suppresses them the instant a real geometrychange proves
      // VK actually works, so they never double-drive.
      if (window === window.top) {
        // Even a top-level VK tab can be an adjustResize WebView, so keep the
        // layout-resize detector (it self-guards dormant when VV really shrinks).
        window.addEventListener('resize', handleLayoutResize);
        return;
      }
      // iframe: fall through to install the VV + layout fallbacks below (once).
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportResize);
      window.visualViewport.addEventListener('scroll', handleViewportScroll);
    }
    // Firefox Android / adjustResize WebView (and VK-present-but-mute iframes):
    // VV shrinks with innerHeight, so neither path above detects the keyboard.
    // This one does. Self-guards dormant when a real VV delta exists.
    window.addEventListener('resize', handleLayoutResize);
  }

  return {
    setupKeyboardDetection,
    handleHostGeometry, // wired to host-bridge's onGeometry by the core
    layoutResizeMode: () => layoutResizeMode,
    // dismissKeyboard's teardown. hostSawOccluded resets with it, so a keyboard
    // dismissed by any other path can't leave a stale "it was occluding" latch that
    // lets the next heartbeat occ=0 kill the following raise.
    resetLayoutMode() { layoutResizeMode = false; hostSawOccluded = false; },
  };
}
