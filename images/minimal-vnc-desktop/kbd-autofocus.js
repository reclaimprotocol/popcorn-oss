// kbd-autofocus.js — mobile soft-keyboard + full IME layer for the noVNC
// (core RFB) viewer, RFB-only (no CDP).
//
// Ported from the neko chromium-headful client's proven mobile input layer
// (client/src/components/video.vue) — same per-platform IME logic and the same
// iOS temp-readonly gesture bridge — but with the transport swapped from CDP
// Input.insertText/dispatchKeyEvent to RFB rfb.sendKey(). Focus detection comes
// from the proxy browser extension over the /kbd WebSocket (see keyboard.go),
// which keeps everything off the CDP path.
//
// Public API (called by liveview.html):
//   PopcornKbd.attach(rfb)   bind to a (re)connected RFB instance
//   PopcornKbd.detach()      unbind (on disconnect); keyboard is dismissed
//
// What it handles:
//   - iOS: beforeinput is the source of truth; temp-readonly-input → real proxy
//     (double-RAF) bridge so the keyboard survives the async focus confirm.
//   - Android: value-comparison in `input` (Samsung Keyboard treats each word
//     as composition); SwiftKey auto-space stripping; Indic (Ridmik) deferred
//     backspace on key='Unidentified'; Gboard swipe/voice batching.
//   - CJK / Korean / Indic composition via compositionend.
//   - visualViewport keyboard show/hide detection + lifting the focused remote
//     field above the keyboard.
//
// Sibling modules under ./kbd/ (imported below) hold the pieces that can be
// separated behind a bounded interface. The pure/stateless leaves — env, keys,
// diag, ripple, ui, ime-hints — take no core dependencies. The stateful-but-
// cohesive subsystems are factory modules: each OWNS its own state and receives
// live accessors for the core state it must read:
//   transport (RFB send path + reconnect keystroke queue) ·
//   latency (link-latency EMAs + dismiss window) · rtt (/kbd ping-pong probe) ·
//   quality (adaptive typing quality) · echo (optimistic typing pill) ·
//   autospace (SwiftKey auto-space stripper) · watchdog (stuck-keyboard reaper) ·
//   clipboard (copy/paste + remote key-chords + field nav) ·
//   desktop-bridge (desktop keysym forwarder + focus handoff) ·
//   viewport-transform (zoom/pan/lift + pinch/pan gestures) ·
//   controls (floating magnify/kbd/paste buttons) ·
//   fit (fit-to-width + magnify emulation + load cover) ·
//   mirror-bar (visible mirror input bar) ·
//   touch-channel (native /input WS + touch mapping/coalescing) ·
//   signal (/kbd focus-signal WS transport).
// Behavior is locked by the characterization suite in ./kbd/test/ (run
// `node --test kbd/test/*.test.mjs`) — keep it green through any refactor.
//
//   ime-input (the per-platform IME state machine: iOS beforeinput, Android
//     value-diff, EditContext, composition, mirror seeding) ·
//   kbd-detect (VK/visualViewport/layout-resize keyboard detectors) ·
//   tap (gesture classification + tap hit-test + screenToRemote) ·
//   proxy-setup (proxy DOM construction + listener wiring) ·
//   field-session (applySignal — the brain — + field/recon/mirror state).
//
// What stays in THIS file is the keyboard lifecycle spine: rfb/rfbReady +
// attach/detach/toggle, the proxy ref + moveProxyTo/parkProxyOffscreen,
// the lifecycle flags (keyboardActive/keyboardOpening/allowBlur/
// keyboardJustDismissed/manualRaise/zoomedToField), raiseKeyboard/
// dismissKeyboard, and the wiring that composes all the factories.

import { isAndroid, isIOS, isTouch, DESKTOP, FIXEDW, MAGNIFY, TOUCH_INPUT, IOS_BRIDGE_IN_IFRAME, nowMs } from './kbd/env.js';
import { dbg, KBD_DEBUG } from './kbd/diag.js';
import { createQuality } from './kbd/quality.js';
import { createEcho } from './kbd/echo.js';
import { createClipboard } from './kbd/clipboard.js';
import { createTouchChannel } from './kbd/touch-channel.js';
import { createWatchdog } from './kbd/watchdog.js';
import { reportHealth } from './kbd/health.js';
import { applyImeHints, secureSurfaceWanted } from './kbd/ime-hints.js';
import { createAutoSpaceFilter } from './kbd/autospace.js';
import { createDesktopBridge } from './kbd/desktop-bridge.js';
import { createViewportTransform } from './kbd/viewport-transform.js';
import { createControls } from './kbd/controls.js';
import { createFit } from './kbd/fit.js';
import { createMirrorBar } from './kbd/mirror-bar.js';
import { createTransport } from './kbd/transport.js';
import { createImeInput } from './kbd/ime-input.js';
import { createKbdDetect } from './kbd/kbd-detect.js';
import { createTap } from './kbd/tap.js';
import { buildProxy, buildSecureProxy } from './kbd/proxy-setup.js';
import { createFieldSession } from './kbd/field-session.js';
import { createSignal } from './kbd/signal.js';
import { createDialog } from './kbd/dialog.js';
import { createPopupBar } from './kbd/popup-bar.js';
import { createNativeSelectProxy } from './kbd/native-select.js';
import { createNativePickerProxy } from './kbd/native-picker.js';
import { hostGeometry, installHostBridge, postToHost, reportInteraction } from './kbd/host-bridge.js';
import { initE2E } from './kbd/e2e.js';
import { createFbScaleWatch, FBSCALE_MODE } from './kbd/fbscale.js';

(function () {
  'use strict';

  // Deploy stamp, logged in the "setup env" klog line. Bump on every deploy so a
  // stale-cache session is provable from the log alone (many "still broken"
  // reports were pages running old JS).
  const BUILD_TAG = 'bundle-83-native-temporal-pickers';

  // ---- RFB transport (replaces CDP Input.*) --------------------------------
  // Lives in ./kbd/transport.js: sendText/sendSpecialKey, per-burst WebSocket
  // frame coalescing (sendBatched), and the bounded reconnect keystroke queue.
  // rfb/rfbReady ownership stays HERE (attach/detach write them; several factory
  // accessors read them). Echo deps are arrows — the echo factory is
  // instantiated later in this file; onSent feeds the drift-recon counter.

  let rfb = null;
  let rfbReady = false; // true only between RFB 'connect' and disconnect/detach

  const transport = createTransport({
    getRfb: () => rfb,
    getRfbReady: () => rfbReady,
    echoAppend: (t) => echoAppend(t),
    echoBackspace: (n) => echoBackspace(n),
    onSent: (delta) => session.noteSent(delta), // drift-recon feed (field-session)
    getFocusKey: () => session.focusKey(),       // tag queued keys so a reconnect can't replay them into another field
  });
  const sendText = transport.sendText;
  const sendSpecialKey = transport.sendSpecialKey;
  const flushSendQueue = transport.flushSendQueue;

  // ---- Mobile input state -----------------------------------------------------
  // The per-platform IME translation state (composition flags, iOS word/chew
  // buffer, EC buffer refs, lastSentValue...) lives in ./kbd/ime-input.js.
  // What stays here is the state SHARED across subsystems.

  let proxy = null;              // hidden <input> the OS IME composes into
  // Android only: the two surfaces the IME can compose into, and which one is
  // live. The EditContext div is the default (glide typing, prediction bar); the
  // secure <input type=password> takes over on password/OTP/card fields, because
  // EditContext cannot tell the IME a field is a secret and the prose pipeline
  // then commits characters the user never typed. applyFieldSurface() picks one.
  let ecProxy = null;            // EditContext div  (non-sensitive fields)
  let secureProxy = null;        // <input type=password> (sensitive fields)

  let keyboardActive = false;    // soft keyboard is up (visualViewport shrunk)
  // Was the user typing when we went to the background? The OS dismisses the keyboard on the way
  // out, so by the time we come back keyboardActive is already false and only this remembers.
  let kbdUpWhenHidden = false;
  let lastRaiseAt = 0;
  let kbdFieldWhenHidden = null;
  let keyboardOpening = false;   // between focus() and viewport actually shrinking
  // Intentional-blur window: an app-driven blur (dismiss, paste, control tap)
  // arms a short deadline, and onSystemBlur ignores any blur landing before it —
  // so a deliberate blur isn't misread as a system back-button/swipe-down dismiss.
  // A monotonic deadline (Math.max), NOT a boolean+reset-timer: overlapping
  // intentional blurs (rapid paste -> tab -> dismiss) each EXTEND the window and
  // the latest wins, where the old boolean's reset timer could fire mid-window and
  // leak a real teardown through the gap ("keyboard randomly dropped").
  const ALLOW_BLUR_MS = 200;
  let allowBlurUntil = 0;
  function armAllowBlur() { allowBlurUntil = Math.max(allowBlurUntil, nowMs() + ALLOW_BLUR_MS); }
  let keyboardJustDismissed = false; // 100ms grace so a touchend doesn't re-pop
  let manualRaise = false;       // keyboard raised by the button/toggle escape hatch;
                                 // suppress the editable=false grace-dismiss until the
                                 // remote confirms a real field (or an explicit dismiss)

  // Grace window after any dismiss so an immediate touchend doesn't re-pop the
  // keyboard. Shared by every dismiss path (explicit, detector-driven, blur).
  function flagJustDismissed(ms) {
    keyboardJustDismissed = true;
    setTimeout(() => { keyboardJustDismissed = false; }, ms);
  }
  // The remote-field session state (rect/hints/viewport/rects, focusKey,
  // sensitivity, mirror value/seed, drift-recon) lives in ./kbd/field-session.js
  // with applySignal, its main writer.

  // ---- SwiftKey auto-space stripper -----------------------------------------
  // Lives in ./kbd/autospace.js (owns the lastCharSent/lastPunctuationTime
  // cross-event context); Android-only and disabled on sensitive fields.
  const autospace = createAutoSpaceFilter({ getSensitiveField: () => session.sensitive() });
  const filterAutoSpace = autospace.filter;

  // ---- Per-platform IME handlers --------------------------------------------
  // The whole input state machine (iOS beforeinput, Android value-diff,
  // EditContext, composition, minimal-diff sender, mirror seeding) lives in
  // ./kbd/ime-input.js — instantiated below, after the echo/clipboard wiring
  // it depends on.

  // ---- Clipboard (copy / paste) --------------------------------------------
  // Copy/paste in both directions + the remote key-chords (Ctrl+V, Shift+Tab,
  // action-key) and iOS accessory-bar field nav live in ./kbd/clipboard.js;
  // instantiate with live accessors + the core's send helpers. Own state
  // (remoteClipboardText / pendingLocalWrite) stays inside the module.
  const clip = createClipboard({
    getRfb: () => rfb,
    getProxy: () => proxy,
    getHints: () => session.hints(),
    getFocusKey: () => session.focusKey(),
    sendText,
    sendSpecialKey,
    clearProxy: () => clearProxy(),
    setAllowBlur: (v) => { if (v) armAllowBlur(); }, // true arms the window; false is a no-op (it expires on its own)
    setKeyboardActive: (v) => { keyboardActive = v; },
  });
  const sendActionKey = clip.sendActionKey;
  const insertPastedText = clip.insertPastedText;
  const navRemoteField = clip.navRemoteField;
  const onProxyPaste = clip.onProxyPaste;
  const flushLocalClipboard = clip.flushLocalClipboard;
  const onRemoteClipboard = clip.onRemoteClipboard;

  // ---- Local echo (optimistic typing) --------------------------------------
  // The optimistic "unconfirmed typing" pill lives in ./kbd/echo.js; instantiate
  // it with live accessors for the core state it reads (mirror-bar visibility,
  // the keyboard's top edge, the RFB-ready flag, and the proxy for IME preview).
  // The echo's own text/composing/allowed state is owned inside the module; the
  // core drives it through the returned API (aliased below to keep call sites
  // unchanged; state reads/writes go through echo.setComposing/setAllowed/etc.).
  const echo = createEcho({
    getMirrorBarShown: () => mirrorBar.shown(),
    getVisibleBottom: () => currentVisibleBottom(),
    getRfbReady: () => rfbReady,
    getProxy: () => proxy,
  });
  const hideEchoPill = echo.hidePill;
  const clearEcho = echo.clear;
  const echoAppend = echo.append;
  const echoBackspace = echo.backspace;
  const reconcileEcho = echo.reconcile;
  const onCompositionUpdate = echo.onCompositionUpdate;

  // ---- Desktop keyboard bridge ---------------------------------------------
  // Lives in ./kbd/desktop-bridge.js: keysym forwarding for non-printable /
  // modified keys, committed-text input, and the proxy<->canvas focus handoff.
  // eventComposing / sendText / sendSpecialKey / applyProxyImeHints are hoisted
  // function declarations; clearEcho is the echo alias defined above.
  const desktopBridge = createDesktopBridge({
    getRfb: () => rfb,
    getProxy: () => proxy,
    sendText,
    sendSpecialKey,
    eventComposing: (e) => input.eventComposing(e),
    applyProxyImeHints,
    clearEcho,
    onProxyPaste,
    flushLocalClipboard,
  });
  const onDesktopKeyDown = desktopBridge.onDesktopKeyDown;
  const onDesktopInput = desktopBridge.onDesktopInput;
  const focusProxyDesktop = desktopBridge.focusProxyDesktop;
  const blurProxyDesktop = desktopBridge.blurProxyDesktop;
  const installDesktopChords = desktopBridge.installDesktopChords;

  // ---- IME input state machine (see ./kbd/ime-input.js) ---------------------
  // Instantiated here so the echo/clipboard aliases above are initialized
  // (direct deps, no arrows needed). toggleKeyboard is hoisted.
  const input = createImeInput({
    getRfb: () => rfb,
    sendText,
    sendSpecialKey,
    sendActionKey,
    echo,
    filterAutoSpace,
    toggleKeyboard,
    getSensitiveField: () => session.sensitive(),
    getRemoteValue: () => session.remoteValue(),
    onMirrorSeedConsumed: () => session.consumeMirrorSeed(),
    // A soft-keyboard text event PROVES the keyboard is up (floating/split
    // keyboards occlude nothing, so the geometric detectors can't see them).
    onInput: () => {
      if (isTouch && !keyboardActive) { keyboardActive = true; startWatchdog(); }
    },
    // System back-button / swipe-down dismiss blurs the proxy without our own
    // flow (which sets allowBlur first). Flip state so the next tap decides
    // cleanly, with a short grace so an immediate touchend doesn't re-pop it.
    onSystemBlur: () => {
      if (keyboardActive && nowMs() >= allowBlurUntil && !document.hidden) {
        dbg('proxy blur -> kbd=false (system dismiss)');
        keyboardActive = false;
        tap.clearLastTap(); // a late editable:true must not recovery-raise after a dismiss
        clearLift();
        hideMirrorBar(); // the visible bar must go with the keyboard
        keyboardJustDismissed = true;
        setTimeout(() => { keyboardJustDismissed = false; }, 100);
      }
    },
  });
  const onProxyBeforeInput = input.onProxyBeforeInput;
  const onProxyInput = input.onProxyInput;
  const onProxyKeyDown = input.onProxyKeyDown;
  const onProxyBlur = input.onProxyBlur;
  const onCompositionStart = input.onCompositionStart;
  const onCompositionEnd = input.onCompositionEnd;
  const onECTextUpdate = input.onECTextUpdate;
  const onECCompositionEnd = input.onECCompositionEnd;
  const onECKeyDown = input.onECKeyDown;
  const clearProxy = input.clearProxy;
  const seedProxyMirror = input.seedProxyMirror;
  const mirrorOn = input.mirrorOn;

  // ---- field surface (keypad hints + Android secrecy) ----------------------
  // The ONE place that reshapes the proxy for the focused remote field, on a new
  // field or a secrecy change (neither implies the other — see field-session.js).
  //
  // A credential field must reach the IME as an <input type=password> or the
  // keyboard runs its prose pipeline on the secret — suggestion strip, word+SPACE
  // on a tap, double-space to ". " (measured, Android 14/Gboard). The send side
  // cannot undo it: those filters skip secrets on purpose. Two mechanisms, since
  // the Android paths differ: the hidden-<input> path retypes its one proxy;
  // EditContext cannot express "secret" at all, so the IME moves to a separate
  // password <input> built at setup.
  let surfaceSecure = false; // secrecy of the surface as last applied
  function applyFieldSurface(sensitive) {
    // ime-hints owns WHICH fields qualify (it excludes OTP and numeric pads);
    // this is the platform half. iOS keeps type=text so the Passwords AutoFill
    // accessory cannot steal proxy focus, and desktop has no prose pipeline to
    // fight — a password proxy there would only attract the browser's own
    // password manager onto a hidden 1px input.
    const want = !isIOS && !DESKTOP && secureSurfaceWanted(session.hints(), sensitive);
    const changed = want !== surfaceSecure;
    surfaceSecure = want;
    if (changed) {
      // A secrecy change is always a different field, so the buffer belongs to the
      // one we are leaving; diffing the new field against it would type the
      // previous field's characters into a password, or backspace over it.
      // Retyping an <input> preserves its value, so this clear is not free.
      clearProxy();
      input.resetComposition();
    }
    if (changed && secureProxy && ecProxy) {
      // EditContext path only: move the IME to the other element. Swapping moves
      // DOM focus, so arm the intentional-blur window first — otherwise the
      // outgoing blur reads as a back-button dismiss and tears the keyboard down
      // mid-login. Android keeps it up across a move between editable elements and
      // just re-reads EditorInfo, which is the whole point.
      const next = want ? secureProxy : ecProxy;
      if (next !== proxy) {
        const hadFocus = document.activeElement === proxy;
        proxy = next;
        input.setProxy(proxy);
        input.setEcMode(proxy === ecProxy);
        // Clear the INCOMING surface too: clearProxy() is per-surface, so a
        // password <input> re-entered later would still hold the previous secret
        // while lastSentValue reads empty, and the first diff would re-send it.
        clearProxy();
        if (hadFocus || keyboardActive) {
          armAllowBlur();
          try { proxy.focus(); } catch (_) {}
        }
      }
    }
    // Hints last: on the <input> paths this is what actually sets type=password,
    // and after a swap it re-derives inputmode/capitalisation for the new element.
    applyProxyImeHints();
  }

  // ---- IME hints (shape the proxy so platform keyboards pick the layout) ---
  // The derivation lives in ./kbd/ime-hints.js (pure function of proxy + hints
  // + mirror flag); this wrapper supplies the core's live currentHints/mirrorOn.

  function applyProxyImeHints() {
    const h = applyImeHints(proxy, session.hints(), { mirrorOn, secure: surfaceSecure });
    // What the extension REPORTED vs what we derived. Logged here (not in the pure
    // ime-hints module) and only under ?kbddebug=1 — it is the single value that
    // decides keyboard layout, capitalisation and the address-field space filter.
    if (h && KBD_DEBUG) {
      dbg('hints tag=' + h.tag + ' type=' + h.type + ' im=' + h.im + ' ac=' + h.ac +
          ' pat=' + h.pat + ' nm=' + h.nm + ' ph=' + h.ph +
          ' -> literal=' + h.literal + ' nospace=' + h.nospace + ' secure=' + (surfaceSecure ? 1 : 0) +
          ' cap=' + h.cap + ' correct=' + h.correct);
    }
  }

  // ---- Stuck-keyboard watchdog ---------------------------------------------
  // Lives in ./kbd/watchdog.js; polls the core keyboard flags via accessors and
  // forces a clean dismiss when the proxy has lost focus with the flag wedged up.
  // dismissKeyboard is a hoisted function declaration — safe to pass directly.
  const watchdog = createWatchdog({
    getKeyboardActive: () => keyboardActive,
    getKeyboardOpening: () => keyboardOpening,
    getKeyboardJustDismissed: () => keyboardJustDismissed,
    getProxy: () => proxy,
    dismissKeyboard,
    // Ask for the focus back before concluding the keyboard is gone. In an embed
    // the page above us runs its own code, and any of it can take focus while the
    // user is still typing — which used to read as "the keyboard went away" and
    // tore down a live session mid-word.
    reclaimFocus: () => { if (proxy) proxy.focus(); },
    // A successful reclaim means somebody up there stole it. That is an
    // integration bug the embedder cannot see from its own side, so say so.
    onFocusStolen: () => reportHealth('focus-stolen'),
    // Does something that CAN see the keyboard still report it occluding? Only
    // an authoritative source counts: the embedder's posted rect, or a live
    // VirtualKeyboard rect. Used to tell "focus dropped but the IME is still up"
    // apart from "the keyboard is gone".
    keyboardOccluding: () => {
      const g = hostGeometry();
      if (g && g.occludedBottom > 0) return true;
      try {
        const vk = navigator.virtualKeyboard;
        if (vk && vk.boundingRect && vk.boundingRect.height > 0) return true;
      } catch (_) {}
      // The adjustResize WebView cell, measured at depth 3 in a real embed chain:
      // the layout viewport shrank for the keyboard, so BOTH the embedder's
      // innerHeight and its visualViewport moved together and it reports
      // occludedBottom=0 — no authoritative rect exists anywhere. Our own
      // layout-resize latch is then the only thing that knows the keyboard is up,
      // and it is exactly as authoritative here: it measured the reflow.
      return detect.layoutResizeMode();
    },
  });
  const startWatchdog = watchdog.start;
  const stopWatchdog = watchdog.stop;

  // ---- Raise / dismiss (iOS gesture bridge) --------------------------------

  function raiseKeyboard(reason) {
    if (!proxy) return;
    lastRaiseAt = nowMs();
    dbg('-> raiseKeyboard(' + (reason || '?') + ') ' + tap.diagnosticTag());
    // Tell the host the keyboard is coming up so it can hide its own bottom-pinned
    // chrome (which would otherwise sit on top of the keys). Sent on INTENT, not on
    // the geometry confirm, because on iOS the confirm can be a second away — the
    // host needs to move before the keys arrive, not after.
    postToHost('POPCORN_KBD_STATE', { active: true, reason: reason || '?' });

    // A raise is always a fresh field. Clear any composition flags a prior field's
    // abandoned composition left latched, so this field's first textupdate takes
    // the normal (non-suppressed) branch. Just the flags — don't touch the EC buffer.
    input.resetComposition();
    // Arm the carry-over space guard (transport): tapping the next field makes the
    // IME commit the previous field's pending word + auto-space, and that lands
    // here. Armed on the raise because it does NOT depend on focusKey changing —
    // the device log shows pages that keep one focusKey across both fields.
    transport.noteFieldReset();

    // An explicit user request (keyboard button / toggle) is the escape hatch for
    // fields we can't focus remotely (cross-origin frame, number/custom widget,
    // closed shadow root). The remote will report editable=false with nothing
    // focused; latch so the false-dismiss grace doesn't yank the keyboard right
    // back down. Cleared once the remote confirms a real field, or on dismiss.
    if (reason === 'button' || reason === 'toggle') manualRaise = true;

    // Every raise is a fresh tap on a field, so the mirror must (re)seed from that
    // field's text. We seed with whatever remoteValue we have now and leave this
    // latched so a value that arrives later on a slow link still seeds — until the
    // user types (onProxyInput clears it).
    session.armMirrorSeed();

    // Bring the proxy on-screen near the tap before focusing (it's parked
    // off-screen while the keyboard is down so miss-taps can't hit it).
    const tapXY = tap.lastTapXY();
    // On iOS, putting the real DOM input at a bottom-page remote field makes
    // WebKit pan the TOP-LEVEL visual viewport by roughly the keyboard height on
    // the first character.  A cross-origin LiveView cannot cancel that pan before
    // its first compositor frame, which is the 309px black flash seen in the
    // simulator.  The proxy only needs to be rendered and focusable inside the
    // gesture; it does not need to sit under the remote field.  Keep it in the
    // top safe strip so Safari has no reason to auto-scroll.  Android retains the
    // under-finger placement used by its input/IME paths.
    const proxyY = isIOS ? 24 : (tapXY.y || Math.round(window.innerHeight / 2));
    moveProxyTo(tapXY.x || Math.round(window.innerWidth / 2),
                proxyY);

    try { proxy.removeAttribute('readonly'); } catch (_) {}
    applyProxyImeHints();

    if (!keyboardActive) keyboardActive = true;
    // Re-arm zoom-to-field for this raise. In novp desktop-fit the field is lifted
    // above the keyboard by zoomToField (applySignal), gated on !zoomedToField.
    // dismissKeyboard resets that guard — but a teardown via the detector paths
    // (onSystemBlur, VK geom h=0 over an app-switch) does NOT, so it can be left
    // stale-true and the re-raise's zoom-to-field is gated out (field stuck behind
    // the keyboard). A raise is always a fresh tap on a field, so reset it here.
    zoomedToField = false;
    startWatchdog();
    updateControlButtons(); // hide zoom/kbd buttons, lift paste above the keyboard
    lowerTypingQuality(); // slow link: shrink echo bytes so glyphs land sooner

    // Claim iframe focus inside the gesture so physical keystrokes route here.
    if (window !== window.top) {
      try { window.focus(); } catch (_) {}
    }

    if (isIOS && (window === window.top || IOS_BRIDGE_IN_IFRAME)) {
      // iOS standalone (or an embed opted in with ?iosbridge=1): temp readonly
      // input → real proxy, keeping the keyboard up while the async
      // editable-confirm resolves.
      const tempInput = document.createElement('input');
      tempInput.style.cssText = 'position:fixed;top:50%;left:50%;width:1px;height:1px;opacity:0;font-size:16px;z-index:99999;';
      tempInput.setAttribute('readonly', 'readonly');
      document.body.appendChild(tempInput);
      tempInput.focus();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          tempInput.removeAttribute('readonly');
          if (!seedProxyMirror()) clearProxy();
          proxy.focus();
          showMirrorBar(); // promote to the visible echo bar (no-op unless mirrorOn)
          setTimeout(() => { if (tempInput.parentNode) tempInput.parentNode.removeChild(tempInput); }, 100);
        });
      });
      return;
    }

    // iOS iframe-embedded OR Android (incl. EditContext): direct focus in-gesture.
    keyboardOpening = true;
    if (!seedProxyMirror()) clearProxy();
    proxy.focus();
    dbg('kbd proxy focus requested active=' + (document.activeElement === proxy ? 1 : 0));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (proxy) proxy.focus();
        dbg('kbd proxy focus settled active=' + (document.activeElement === proxy ? 1 : 0) +
          ' vv=' + (window.visualViewport ? Math.round(window.visualViewport.width) + 'x' + Math.round(window.visualViewport.height) : '-') +
          ' win=' + window.innerWidth + 'x' + window.innerHeight);
        showMirrorBar(); // promote to the visible echo bar (no-op unless mirrorOn)
        setTimeout(() => { keyboardOpening = false; }, 500);
      });
    });
  }

  // Bulletproof dismiss — unwind every piece of state at once, then blur (and
  // for iOS do a readonly round-trip that some builds need to actually hide).
  function dismissKeyboard() {
    dbg('-> dismissKeyboard');
    postToHost('POPCORN_KBD_STATE', { active: false });
    armAllowBlur();
    keyboardActive = false;
    keyboardOpening = false;
    manualRaise = false;
    detect.resetLayoutMode();
    transport.noteFieldReset(); // next field starts fresh (see the guard in transport)
    // A deliberate dismiss must win over a late confirm: zero lastTapAt so a
    // stale editable:true landing after the user closed the keyboard (routine on
    // 3G, where the confirm arrives seconds later) can't trip the recovery-raise
    // gate and re-pop it. Also stops an interrupted tap->confirm from polluting
    // emaLatency. Clear the composition flags for the same reason as raise/blur.
    tap.clearLastTap();
    input.resetComposition();
    stopWatchdog();
    updateControlButtons(); // restore zoom/kbd buttons, hide the paste button
    session.clearFalseDismiss(); // no stale transient-blur timer after an explicit dismiss
    restoreTypingQuality(); // back to configured crisp quality now typing stopped
    // Whole-page desktop-fit (novp): KEEP the zoomed-into-field view when the
    // keyboard closes — snapping back to the whole-page overview every time was
    // jarring (you lose your place after every edit). The floating magnify button
    // toggles back to the overview when the user actually wants it, and tapping a
    // different field re-zooms to that one (applySignal's zoom-into-field). Only
    // zoomedToField (the per-session guard) is cleared; the zoom/pan stays put.
    zoomedToField = false;
    clearLift();
    clearEcho();
    try { window.scrollTo(0, 0); } catch (_) {}
    keyboardJustDismissed = true;
    setTimeout(() => { keyboardJustDismissed = false; }, 150);
    if (proxy) {
      clearProxy(); // Samsung commits residual value on next field otherwise
      proxy.blur();
      if (isIOS && !input.ecMode()) {
        try {
          proxy.setAttribute('readonly', 'readonly');
          requestAnimationFrame(() => { if (proxy) { proxy.removeAttribute('readonly'); proxy.blur(); } });
        } catch (_) {}
      }
      parkProxyOffscreen(); // keep it out from under future taps while down
    }
  }

  function toggleKeyboard() {
    dbg('toggleKeyboard (active=' + (keyboardActive ? 1 : 0) + ')');
    if (keyboardActive) dismissKeyboard();
    else raiseKeyboard('toggle');
  }

  // App/tab returned to the foreground. While we were backgrounded the OS closes
  // the soft keyboard, but our system-blur handler is gated out under
  // document.hidden and a frozen tab doesn't fire the visualViewport/VK geometry
  // detectors — so keyboardActive (and the field lift) can be left stale-UP over
  // a real app-switch. On return the stale appliedLift no-op guard then blocks
  // every lift re-apply path, so the next tap reopens the keyboard with NO lift
  // (the field stays hidden behind it). Reconcile: if the keyboard is actually
  // down now, tear the stale state down so the next tap raises and lifts cleanly.
  // Deferred a beat so visualViewport has settled after the resume.
  function reconcileKeyboardOnForeground() {
    if (!isTouch) return;
    setTimeout(() => {
      if (document.hidden) return;
      const shrunk = (window.innerHeight - currentVisibleBottom()) > 50;
      if (keyboardActive && !shrunk) {
        dbg('foreground reconcile: kbd actually down -> dismiss stale state');
        dismissKeyboard();
      }
      if (shrunk || keyboardActive) return; // genuinely up: nothing to reconcile
      // The keyboard the user was typing on is gone (the OS dismisses it on the way out) while
      // the remote still holds that field focused, so nothing can be typed and a fresh tap is
      // the only way back — which reads as "the field won't take input" after a trip to a
      // password manager. Restore what the user left. Keyed on the SAME field we raised for, so
      // a keyboard the user deliberately dismissed does not come back. iOS is excluded: it
      // forbids a programmatic raise outside a gesture.
      if (!kbdUpWhenHidden || isIOS) return;
      kbdUpWhenHidden = false;
      const key = session.remoteFocusKey();
      if (!key || key !== kbdFieldWhenHidden) return;
      dbg('foreground reconcile: field still focused remotely -> re-raise');
      raiseKeyboard('foreground');
    }, 300);
  }


  // ---- Field lift + client-side pinch-zoom/pan ------------------------------
  // The #screen transform subsystem (zoom/pan/lift state, pinch+pan gesture
  // state machines, zoom-to-field, keyboard lift math) lives in
  // ./kbd/viewport-transform.js. Gesture CLASSIFICATION stays in the touch
  // handlers below; they call in via the aliases. Deferred arrows point at
  // core functions that later stages move into their own modules (fit/controls).

  function screenElement() { return document.getElementById('screen'); }

  // Assigned after the field session is constructed. viewport-transform and
  // tap receive deferred closures because they are instantiated earlier.
  let nativeSelect = null;
  let nativePicker = null;

  const vt = createViewportTransform({
    getScreenElement: () => screenElement(),
    getCurrentRect: () => session.rect(),
    getCurrentViewport: () => session.viewport(),
    getLayoutResizeMode: () => detect.layoutResizeMode(),
    getZoomedToField: () => zoomedToField,
    positionMirrorBar: () => positionMirrorBar(),
    getReadableZoom: () => readableZoom(),
    onZoomSettled: () => setMagnifyState(),
    getFitMode: () => fit.fitMode(),
    // Deferred (fit is instantiated below): a CSS zoom must freeze the remote
    // framebuffer size, since noVNC derives it from #screen's transformed rect.
    onZoomFreeze: (on) => fit.setZoomFreeze(on),
    onTransform: () => {
      if (nativeSelect) nativeSelect.refresh();
      if (nativePicker) nativePicker.refresh();
    },
  });
  const zoomToField = vt.zoomToField;
  const beginPinch = vt.beginPinch;
  const updatePinch = vt.updatePinch;
  const endPinch = vt.endPinch;
  const beginPan = vt.beginPan;
  const updatePan = vt.updatePan;
  const applyLift = vt.applyLift;
  const clearLift = vt.clearLift;
  const currentVisibleBottom = vt.currentVisibleBottom;
  const postViewport = vt.postViewport;
  const isZoomed = vt.isZoomed;
  const toggleMagnify = vt.toggleMagnify;

  // ---- Floating magnify / fit toggle ---------------------------------------
  // The floating control buttons (magnify/fit toggle, keyboard toggle, paste)
  // and their visibility policy live in ./kbd/controls.js. Deps: vt (created
  // above), the hoisted raise/dismiss/focusClosestInput declarations, and the
  // same setter-injection shape clipboard.js uses (pasteFromDevice writes
  // allowBlur/keyboardActive). readableZoom stays here until fit.js (B3).
  const controls = createControls({
    getKeyboardActive: () => keyboardActive,
    isZoomed,
    toggleMagnify,
    raiseKeyboard,
    dismissKeyboard,
    focusClosestInput: () => tap.focusClosestInput(),
    getRemoteFocusKey: () => session.focusKey(),
    insertPastedText,
    getProxy: () => proxy,
    setAllowBlur: (v) => { if (v) armAllowBlur(); }, // true arms the window; false is a no-op (it expires on its own)
    setKeyboardActive: (v) => { keyboardActive = v; },
  });
  const makeMagnifyButton = controls.makeMagnifyButton;
  const setMagnifyState = controls.setMagnifyState;
  const updateControlButtons = controls.updateControlButtons;
  const onMagButton = controls.onMagButton;
  const pasteFromDevice = controls.pasteFromDevice;

  // readableZoom lives in ./kbd/fit.js (aliased below at the fit factory).

  // focusClosestInput lives in ./kbd/tap.js (controls receives an arrow).

  // The startup/reflow cover lives in ./kbd/fit.js (showCover/hideCover/
  // revealWhenSettled) — its only drivers are the fit dance and startMagnify.

  // ---- Keyboard visibility detectors (see ./kbd/kbd-detect.js) --------------
  // VK geometrychange + visualViewport + layout-resize, with the vkSeen latch
  // that keeps them from double-driving. They DRIVE keyboardActive via setter
  // injection; layoutResizeMode is owned there (vt reads it via accessor).
  const detect = createKbdDetect({
    getKeyboardActive: () => keyboardActive,
    setKeyboardActive: (v) => { keyboardActive = v; },
    getKeyboardOpening: () => keyboardOpening,
    getProxy: () => proxy,
    applyLift,
    clearLift,
    postViewport,
    currentVisibleBottom,
    framebufferFitsWindow: vt.framebufferFitsWindow,
    revealFocusedRemote,
    hideMirrorBar: () => hideMirrorBar(),
    startWatchdog,
    flagJustDismissed,
    getLastInputAt: () => input.lastInputAt(),
  });
  const setupKeyboardDetection = detect.setupKeyboardDetection;

  // ---- Tap detection ---------------------------------------------------------
  // Gesture classification, the tap->keyboard hit-test, and screenToRemote live
  // in ./kbd/tap.js (instantiated below, after the touch channel it drives).

  // ---- Native touch input channel (magnify + touch) ------------------------
  // The native /input WebSocket + touch-point mapping/coalescing live in
  // ./kbd/touch-channel.js; the gesture handlers below own classification and
  // call into it (via the aliases). We take over touch entirely and block
  // noVNC's gesture->mouse path so the remote gets exactly one native stream.
  // TOUCH_INPUT is derived once in ./kbd/env.js (shared by touch-channel + tap).
  const tc = createTouchChannel({
    getRfb: () => rfb,
    getScreenElement: () => screenElement(),
    getViewport: () => session.viewport(),
    getRemoteTouchActive: () => tap.remoteTouchActive(),
    // Every forwarded scroll/drag funnels through here, so it doubles as the
    // 'scroll' interaction report for an embedding host's analytics. Already
    // coalesced upstream (touch-channel batches moves), so this is not per-pixel.
    noteRemoteScroll: () => {
      tap.noteRemoteScroll(); quality.noteMotion(); reportInteraction('scroll');
      // The remote page just moved under rects we published before it did.
      if (nativeSelect) nativeSelect.noteRemoteScroll();
      if (nativePicker) nativePicker.noteRemoteScroll();
    },
  });
  const connectInput = tc.connectInput;
  const sendTouch = tc.sendTouch;
  const sendPointerClick = tc.sendPointerClick;
  const touchToRemote = tc.touchToRemote;
  const collectPoints = tc.collectPoints;
  const queueMove = tc.queueMove;
  const cancelPendingMove = tc.cancelPendingMove;

  // In the adjustResize cell (Android WebView, Firefox Android) the keyboard shrinks OUR window,
  // so #screen is the small box and no transform can reveal the field — only the remote scrolling
  // can. Synthesize the swipe a finger would make, in a column clear of the field's own rect so it
  // cannot land a caret. Bounded: one reveal per focused field per keyboard open.
  let revealedFor = '';
  function revealFocusedRemote(visibleBottom) {
    const rect = session.rect();
    const viewport = session.viewport();
    if (!rect || !viewport || !(visibleBottom > 0)) return false;
    const key = session.remoteFocusKey ? String(session.remoteFocusKey()) : '';
    const deficit = Math.round(rect.y + rect.h + 24 - visibleBottom);
    if (deficit <= 8) { revealedFor = ''; return false; }
    if (revealedFor === key + ':' + deficit) return false;
    revealedFor = key + ':' + deficit;
    const x = Math.max(8, Math.min(rect.x - 24, viewport.w - 8));
    const y0 = Math.max(40, visibleBottom - 40);
    const y1 = Math.max(8, y0 - deficit);
    dbg('reveal: remote scroll ' + deficit + 'px (field ' + Math.round(rect.y) + ' vs visible ' + Math.round(visibleBottom) + ')');
    sendTouch('start', [{ x, y: y0 }]);
    for (let i = 1; i <= 3; i++) {
      sendTouch('move', [{ x, y: Math.round(y0 + (y1 - y0) * (i / 3)) }]);
    }
    sendTouch('end', [{ x, y: y1 }]);
    return true;
  }

  const tap = createTap({
    vt,
    beginPinch, updatePinch, endPinch, beginPan, updatePan,
    sendTouch, sendPointerClick, collectPoints, queueMove, cancelPendingMove,
    flushPendingMove: tc.flushPendingMove,
    touchToRemote,
    onMagButton: (t) => onMagButton(t),        // controls alias (defined earlier — arrow for uniform deferral)
    describeNativeSelectAt: (x, y) => (nativeSelect ? nativeSelect.describeAt(x, y) : '-'),
    onDialogSheet: (t) => (nativeSelect && nativeSelect.owns(t)) ||
      (nativePicker && nativePicker.owns(t)) || dialog.owns(t) || popupBar.owns(t), // viewer chrome, not remote touch
    pasteFromDevice: () => pasteFromDevice(),
    flushLocalClipboard,
    raiseKeyboard, dismissKeyboard, parkProxyOffscreen, // hoisted
    zoomToHitField: (rect) => {
      // The field rect that won the local tap hit-test is trustworthy enough for
      // an immediate visual zoom. Waiting for the remote focus heartbeat made
      // fixed-width sites feel broken on a high-latency tunnel.
      if (!fit.fieldZoomWorthwhile() || fit.wantReadable() || zoomedToField) return;
      zoomedToField = true;
      zoomToField(rect);
    },
    armDismiss: () => session.armDismiss(), // field-session (created later — deferred)
    inputReady: () => tc.inputReady(),
    getKeyboardActive: () => keyboardActive,
    getKeyboardJustDismissed: () => keyboardJustDismissed,
    getEcMode: () => input.ecMode(),
    getRemoteFocusKey: () => session.focusKey(),
    getInputRects: () => session.inputRects(),
    getXFrames: () => session.xframes(),
    getViewport: () => session.viewport(),
    getLastNonEmptyRectsAt: () => session.lastNonEmptyRectsAt(),
    getRectsTruncated: () => session.rectsTruncated(),
    getRectsGen: () => session.rectsGen(),
    getCoverageBlind: () => session.coverageBlind(),
    getRemoteScrollBottom: () => session.remoteScrollBottom(),
    getFocusedScrollContainer: () => session.focusedScrollContainer(),
    getGestureID: () => tc.gestureID(),
    getProxy: () => proxy,
    getScreenElement: () => screenElement(),
  });

  // Position the proxy's 40x20 hit-area near a point (used only when we're
  // about to raise the keyboard, so iOS focuses a visible in-gesture element
  // and doesn't scroll/zoom to an off-screen input).
  function moveProxyTo(x, y) {
    if (!proxy) return;
    proxy.style.left = Math.max(0, x - 20) + 'px';
    proxy.style.top = Math.max(0, y - 10) + 'px';
  }

  // Park the proxy far off-screen. CRITICAL: the proxy is a focusable <input>
  // with no pointer-events:none (iOS needs it interactive), so while it sits
  // on-screen a tap that lands on it is NATIVELY focused by the browser —
  // opening the soft keyboard even though our hit-test classified the tap as a
  // miss. Keeping it off-screen whenever the keyboard should be down makes a
  // miss-tap physically unable to reach it; we only move it on-screen inside
  // raiseKeyboard, the one moment we actually want focus.
  function parkProxyOffscreen() {
    hideMirrorBar(); // a visible bar must never linger off-screen / after dismiss
    if (proxy) { proxy.style.left = '-9999px'; proxy.style.top = '0px'; }
  }

  // ---- Visible mirror bar (A1) ---------------------------------------------
  // Lives in ./kbd/mirror-bar.js — promotes the proxy into a visible input bar
  // above the keyboard in mirror mode. mirrorOn is hoisted; getVisibleBottom
  // rides the viewport-transform instance; the bar supersedes the echo pill.
  const mirrorBar = createMirrorBar({
    getProxy: () => proxy,
    mirrorOn,
    getVisibleBottom: () => currentVisibleBottom(),
    hideEchoPill,
  });
  const showMirrorBar = mirrorBar.show;
  const positionMirrorBar = mirrorBar.position;
  const hideMirrorBar = mirrorBar.hide;

  // screenToRemote / hitTest / handleTap live in ./kbd/tap.js.

  // ---- Dismiss-if-not-editable timer (RTT adaptive) ------------------------

  // ---- Adaptive quality while typing (3G latency-masking) ------------------
  // The typing-time quality downgrade lives in ./kbd/quality.js; instantiate it
  // with a live accessor for the reconnect-swappable rfb.
  const quality = createQuality({ getRfb: () => rfb });
  const lowerTypingQuality = quality.lower;
  const restoreTypingQuality = quality.restore;

  // armDismiss/clearDismiss (the RTT-adaptive dismiss-if-not-editable timer)
  // live in ./kbd/field-session.js with applySignal.

  // ---- Mobile viewport magnify (opt-in via ?magnify=1) ---------------------
  // The magnify/fit-to-width subsystem (fit state machine, /emulate pushes, the
  // load cover, startMagnify, the applySignal pid/fit-detection block, and the
  // reconnect zoom snapshot) lives in ./kbd/fit.js. zoomedToField stays here —
  // it is keyboard-session state written by dismissKeyboard/applySignal and
  // read by vt.applyLift.
  let zoomedToField = false; // whether we've zoomed into the focused field this keyboard session (novp fit)

  const fit = createFit({
    getRfb: () => rfb,
    getScreenElement: () => screenElement(),
    getKeyboardActive: () => keyboardActive,
    vt,
    setMagEligible: controls.setMagEligible,
    updateControlButtons: controls.updateControlButtons,
    onNavChanged: () => session.clearRectStickiness(),
  });
  const readableZoom = fit.readableZoom;
  const reapplyFitOnReconnect = fit.reapplyFitOnReconnect;
  const startMagnify = fit.startMagnify;

  // ---- /kbd signal channel ---------------------------------------------------
  // applySignal (the brain), drift detection, the dismiss timer, and all the
  // field-session state live in ./kbd/field-session.js. It orchestrates the
  // sibling modules directly (tap/fit/input/echo instances) and reaches the
  // keyboard lifecycle via the hoisted raise/dismiss declarations.
  const session = createFieldSession({
    // Replay a tap's missing click over the SAME ordered CDP queue the cross-origin compat
    // click uses, so it cannot race the touch before it. No VNC fallback: that path wants
    // screen coords and this point is in remote px, and a tap with no /input socket had no
    // touch to complete either.
    sendCompatClick: (p) => sendTouch('click', [p]),
    tap,
    fit,
    input,
    echo,
    mirrorOn,
    seedProxyMirror,
    clearEcho,
    reconcileEcho,
    // Trailing-space repair sends a remote Backspace of its own (see
    // repairTrailingSpace); onSent already feeds the drift counter from here.
    sendSpecialKey,
    applyFieldSurface,
    zoomToField,
    applyLift,
    currentVisibleBottom,
    focusProxyDesktop,
    blurProxyDesktop,
    mirrorBarShown: () => mirrorBar.shown(),
    showMirrorBar: () => showMirrorBar(),
    raiseKeyboard,
    dismissKeyboard,
    getKeyboardActive: () => keyboardActive,
    getProxy: () => proxy,
    getManualRaise: () => manualRaise,
    setManualRaise: (v) => { manualRaise = v; },
    getZoomedToField: () => zoomedToField,
    setZoomedToField: (v) => { zoomedToField = v; },
  });
  nativeSelect = createNativeSelectProxy({
    enabled: isTouch && MAGNIFY,
    getScreenElement: () => screenElement(),
    sendChoice: (choice) => sig.sendControl({ selectChoice: choice }),
  });
  nativePicker = createNativePickerProxy({
    enabled: isTouch && MAGNIFY,
    getScreenElement: () => screenElement(),
    sendChoice: (choice) => sig.sendControl({ pickerChoice: choice }),
  });
  const applySignal = (state) => {
    session.applySignal(state);
    nativeSelect.applySignal(state);
    nativePicker.applySignal(state);
  };
  const armDismiss = session.armDismiss;

  // The /kbd focus-signal WebSocket transport (connect, backoff-reconnect, the
  // stale-socket reaper, and the network-back kick) lives in ./kbd/signal.js; the
  // RTT ping/pong probe it drives lives in ./kbd/rtt.js. applySignal (above) owns
  // all state mutation — signal.js just decodes frames and hands them off.
  // JS dialog sheet (alert/confirm/prompt/beforeunload). Chromium's own dialog is
  // laid out against the real window, so under mobile emulation it overflows and
  // its OK button can be unreachable — and a dialog blocks the page, so that
  // wedges it. The proxy forwards the dialog and executes our reply (kbd/dialog.js).
  const dialog = createDialog({
    sendReply: (r) => sig.sendControl({ dialogReply: r }),
  });

  // Close button for a script-opened popup window (OAuth "Continue with
  // Google"). The proxy fullscreens those windows so they're usable on a phone,
  // which strips their own close button — and the popup lives in the remote
  // browser, so it outlives a viewer reload. See kbd/popup-bar.js.
  const popupBar = createPopupBar({
    sendClose: (r) => sig.sendControl({ popupClose: r }),
  });

  const sig = createSignal({
    applySignal,
    applyDialog: (d) => dialog.apply(d),
    applyPopup: (p) => popupBar.apply(p),
    kickInput: tc.kick,
    getInputSock: tc.getInputSock,
    onConnection: (open) => {
      nativeSelect.setTransportReady(open);
      nativePicker.setTransportReady(open);
    },
  });
  const connectSignal = sig.connectSignal;
  const kickReconnects = sig.kickReconnects;
  const startStateBridge = sig.startStateBridge;
  const startKbdStaleWatch = sig.startKbdStaleWatch;

  // ---- Setup / public API --------------------------------------------------

  let initialized = false;
  // Supersampled-framebuffer policy watcher (kbd/fbscale.js), created in setup().
  let fbScaleWatch = null;

  // Retry incomplete startup work until it converges or times out.
  const CONVERGE_FAST_TICK_MS = 250;
  const CONVERGE_FAST_PHASE_MS = 8000;
  const CONVERGE_SLOW_TICK_MS = 1000;
  const CONVERGE_MAX_MS = 60000;
  let convergeTimer = null;
  let convergeStart = 0;
  let convergeFast = true;
  // Framebuffer retries are rate-limited.
  const FB_DRIVE_MIN_GAP_MS = 2500;
  const FB_MAX_DRIVES = 4;
  let fbDriveAt = 0;
  let fbDrives = 0;
  function convergenceGaps() {
    const gaps = [];
    if (MAGNIFY) {
      const isock = tc.getInputSock();
      if (!isock || isock.readyState !== WebSocket.OPEN) gaps.push('input');
    }
    if (!sig.isOpen()) gaps.push('kbd');
    if (rfbReady && !fit.framebufferConverged()) gaps.push('fb');
    return gaps;
  }
  function stopConvergenceWatch() {
    if (convergeTimer !== null) { clearInterval(convergeTimer); convergeTimer = null; }
  }
  function convergeTick() {
    const gaps = convergenceGaps();
    if (!gaps.length) {
      dbg('converged after ' + Math.round(nowMs() - convergeStart) + 'ms');
      stopConvergenceWatch();
      return;
    }
    const elapsed = nowMs() - convergeStart;
    if (elapsed > CONVERGE_MAX_MS) {
      dbg('convergence gave up, still missing: ' + gaps.join(','));
      stopConvergenceWatch();
      return;
    }
    dbg('converge re-drive: ' + gaps.join(','));
    if (gaps.indexOf('input') !== -1 || gaps.indexOf('kbd') !== -1) kickReconnects();
    if (gaps.indexOf('fb') !== -1 && fbDrives < FB_MAX_DRIVES &&
        nowMs() - fbDriveAt >= FB_DRIVE_MIN_GAP_MS) {
      fbDriveAt = nowMs();
      fbDrives++;
      fit.resettleOnConnect();
    }
    if (convergeFast && elapsed > CONVERGE_FAST_PHASE_MS) {
      convergeFast = false;
      if (convergeTimer !== null) { clearInterval(convergeTimer); convergeTimer = null; }
      convergeTimer = setInterval(convergeTick, CONVERGE_SLOW_TICK_MS);
    }
  }
  function startConvergenceWatch() {
    if (convergeTimer !== null) return;
    convergeStart = nowMs();
    convergeFast = true;
    fbDrives = 0;
    fbDriveAt = 0;
    convergeTimer = setInterval(convergeTick, CONVERGE_FAST_TICK_MS);
  }

  function setup() {
    if (initialized || (!isTouch && !DESKTOP)) return;
    initialized = true;
    dbg('setup env: ios=' + (isIOS ? 1 : 0) + ' android=' + (isAndroid ? 1 : 0) +
      ' touch=' + (isTouch ? 1 : 0) + ' desktop=' + (DESKTOP ? 1 : 0) +
      ' ec=' + (!DESKTOP && !isIOS && typeof window.EditContext === 'function' ? 1 : 0) +
      ' vk=' + (navigator.virtualKeyboard ? 1 : 0) + ' vv=' + (window.visualViewport ? 1 : 0) +
      ' top=' + (window === window.top ? 1 : 0) + ' magnify=' + (MAGNIFY ? 1 : 0) +
      // fixedw is logged because "is the flag even on?" was otherwise unanswerable
      // from the log: MAGNIFY reads 1 either way (FIXEDW implies it), and the two
      // modes' fit lines differ only in a width you have to know to look for. A
      // session debugged as "the fixed-width mode is zoomed in" turned out to be
      // plain ?magnify=1 escalating to a 508px fit at readable zoom 1.41.
      ' fixedw=' + FIXEDW +
      ' iw=' + window.innerWidth + ' ih=' + window.innerHeight + ' build=' + BUILD_TAG);
    // An embedded viewer without allow="virtual-keyboard" gets the VK object but
    // never a rect, and a subframe's visualViewport does not reliably shrink
    // either — so in that configuration the HOST's geometry is the only thing
    // keeping the keyboard usable, and the embedder should know it is load-bearing
    // before a user finds out.
    //
    // ASK THE POLICY, not the object. `navigator.virtualKeyboard` is present
    // either way and `boundingRect` is a real (0x0) rect whether the feature was
    // denied or the keyboard is merely closed — verified in Chrome against an
    // iframe with the token missing, where the object-shape check reported a
    // perfectly healthy `vk=1`. The permissions policy is the only thing that
    // answers the actual question, and it answers it at load, before any keyboard
    // has had a chance to open.
    try {
      const pol = document.permissionsPolicy || document.featurePolicy;
      if (window !== window.top && pol && typeof pol.allowsFeature === 'function' &&
          !pol.allowsFeature('virtual-keyboard')) reportHealth('no-virtual-keyboard');
    } catch (_) { /* no policy API here: cannot tell, so say nothing */ }

    // EditContext (Chromium/Android) drives the IME natively — glide/swipe typing
    // and the prediction bar work through it. SwiftKey's autocorrect-on-space is
    // NATIVE keyboard behavior (it fires the same on any field, EditContext or a
    // plain <input>), so it's kept, not fought; the del=0 re-grab that used to
    // DUPLICATE the word is fixed in onECTextUpdate. A plain <input> with
    // autocorrect off would only lose glide + suggestions without stopping the
    // (dictionary-level) autocorrect, so EditContext stays the Android path.
    // Guard on !isIOS too: if a future iOS build ships EditContext, every iOS
    // device stays on the exercised WebKit <input> path (accessory bar, mirror,
    // QuickType-off, chew buffer) instead of the never-tested EC path.
    const ecMode = !DESKTOP && !isIOS && typeof window.EditContext === 'function';
    input.setEcMode(ecMode);
    dbg('ime pipeline=' + (DESKTOP ? 'desktop-keys' : (ecMode ? 'editcontext' : (isIOS ? 'beforeinput' : 'input-events'))) + ' keyboard-app=not-exposed');
    if (isIOS && typeof window.EditContext === 'function') {
      dbg('WARN iOS now exposes EditContext — staying on WebKit input path (revisit ecMode)');
    }

    // Proxy DOM construction + listener wiring lives in ./kbd/proxy-setup.js.
    const built = buildProxy(DESKTOP ? 'desktop' : (ecMode ? 'ec' : 'input'), {
      // desktop path
      onDesktopKeyDown, onDesktopInput, onProxyPaste,
      // EC path
      onECTextUpdate, onECCompositionEnd, onECKeyDown,
      // iOS/<input> path
      onProxyBeforeInput, onProxyInput, onProxyKeyDown,
      // shared
      onProxyBlur, onCompositionStart, onCompositionUpdate, onCompositionEnd,
    }, navRemoteField);
    proxy = built.proxy;
    input.setProxy(proxy); // the input state machine's handlers use a local ref
    if (built.editCtx) input.setEditContext(built.editCtx);
    if (ecMode) {
      // Built up front, not on the first sensitive field: creating and focusing an
      // <input> in the same turn as the signal asking for it races the keyboard's
      // own restart, and a password is where a dropped keyboard costs most.
      ecProxy = built.proxy;
      secureProxy = buildSecureProxy({
        onProxyBeforeInput, onProxyInput, onProxyKeyDown,
        onProxyBlur, onCompositionStart, onCompositionUpdate, onCompositionEnd,
      });
    }

    if (DESKTOP) {
      connectSignal(); // /kbd focus signal drives proxy focus on desktop too
      installDesktopChords(); // ⌘/Ctrl + A/C/X/V, canvas-focused included
      // The portal's own paste button. Only onPaste — geometry and the
      // magnify/keyboard toggles have nothing to drive on desktop.
      installHostBridge({
        onPaste: (text) => { dbg('host cmd paste len=' + text.length); insertPastedText(text); },
      onHostLayout: (r) => dbg('host layout ' + (r.issues.length ? r.issues.join(',') : 'ok') +
        ' reason=' + r.reason + ' top=' + (r.top ? 1 : 0) + ' depth=' + r.depth +
        ' css=' + r.cssW + 'x' + r.cssH + ' dpr=' + r.dpr, r.issues.length > 0),
      });
      window.addEventListener('online', kickReconnects);
      window.addEventListener('pageshow', kickReconnects);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) kickReconnects(); });
      return;
    }
    // Input->paint tracing (?e2e=). Returns null and installs nothing when the
    // flag is absent, so the untraced path stays a null check per input event.
    initE2E({
      getScreenElement: () => screenElement(),
      // WHERE to look for the paint. Typing changes a caret and a couple of glyphs
      // inside one field; a uniform sample grid lands between them and reports
      // `paint=none` for a keystroke that is plainly on screen. The focused rect
      // arrives on /kbd in REMOTE pixels, which are framebuffer pixels — the same
      // 1:1 mapping tap.js relies on — so it can be handed straight to the sampler.
      getFieldRect: () => session.rect(),
    });
    // Supersampled framebuffer (kbd/fbscale.js). Starts at 1x — today's behaviour —
    // and steps up only once the tunnel RTT has been measured healthy for a few
    // seconds, so a cold start and a slow link cost exactly what they cost now.
    // Blocked while a CSS zoom holds the framebuffer size frozen or a fit dance owns
    // it; the watcher just tries again on its next tick.
    fbScaleWatch = createFbScaleWatch({
      getCurrent: () => fit.fbScale(),
      getBlocked: () => fit.fitMode() || vt.zoomScale() > 1.01 || !rfbReady,
      onChange: (k) => fit.applyFbScale(k),
    });
    parkProxyOffscreen(); // start off-screen; raiseKeyboard brings it in when needed

    // Kill the viewer browser's own page zoom on the stream. Native two-finger
    // gestures are routed through /input to the remote website; when that channel
    // is unavailable, the controlled client transform is the fallback.
    if (isTouch) { try { const sc = screenElement(); if (sc) sc.style.touchAction = 'none'; } catch (_) {} }
    if (isTouch) makeMagnifyButton(); // floating zoom/fit toggle (mobile only)

    tap.installTouchHandlers(); // touch gestures + compat-mouse swallow (see ./kbd/tap.js)
    // A real mouse/trackpad is passed through to noVNC's own pointer path (see the
    // compat-mouse swallow), which is blind to our CSS zoom — so its clicks land
    // zoomScale-times off. Correct the coordinates before noVNC reads them. Inert
    // at zoom 1, so it costs nothing on the non-zoomed paths.
    vt.installPointerZoomFix();

    setupKeyboardDetection();
    // Embedded viewer: let the host drive what only it can see (the keyboard
    // rect) and what belongs to its own chrome (its magnify/keyboard/paste
    // buttons). No-op in a top-level tab and in an embed that hasn't opted in
    // with ?parentOrigin= — see ./kbd/host-bridge.js for the origin policy.
    installHostBridge({
      onGeometry: detect.handleHostGeometry,
      onToggleMagnify: () => { dbg('host cmd toggle-magnify'); toggleMagnify(); },
      onToggleKeyboard: () => { dbg('host cmd toggle-kbd'); toggleKeyboard(); },
      onPaste: (text) => { dbg('host cmd paste len=' + text.length); insertPastedText(text); },
      onHostLayout: (r) => dbg('host layout ' + (r.issues.length ? r.issues.join(',') : 'ok') +
        ' reason=' + r.reason + ' top=' + (r.top ? 1 : 0) + ' depth=' + r.depth +
        ' css=' + r.cssW + 'x' + r.cssH + ' dpr=' + r.dpr, r.issues.length > 0),
    });
    connectInput(); // native touch channel (no-op unless magnify + touch)

    connectSignal();
    startStateBridge();
    startKbdStaleWatch(); // reap half-open /kbd sockets on lossy mobile links
    startConvergenceWatch(); // re-drives whatever above did not land (see above)
    if (fbScaleWatch) fbScaleWatch.start();

    // Network-back signals: reconnect the idle WS channels immediately instead
    // of waiting out the exponential backoff (up to 10s). Mobile networks fire
    // these on cell<->wifi handoff and on returning to the tab. Foreground events
    // (pageshow / visible) ALSO reconcile a keyboard left stale-up over a
    // background (see reconcileKeyboardOnForeground); `online` is network-only.
    window.addEventListener('online', kickReconnects);
    window.addEventListener('pageshow', () => { kickReconnects(); reconcileKeyboardOnForeground(); });
    document.addEventListener('visibilitychange', () => {
      // A system dismiss can beat this event, so accept a very recent raise as "was typing" too.
      if (document.hidden) {
        kbdUpWhenHidden = keyboardActive || (nowMs() - lastRaiseAt < 15000);
        kbdFieldWhenHidden = kbdUpWhenHidden ? session.remoteFocusKey() : null;
        return;
      }
      kickReconnects();
      reconcileKeyboardOnForeground();
      setTimeout(() => fit.refreshAfterVisibility(), 0);
    });
  }

  // startMagnify lives in ./kbd/fit.js (aliased at the fit factory above).

  window.PopcornKbd = {
    isTouch,
    attach(instance, alreadyConnected) {
      dbg('attach (touch=' + (isTouch ? 1 : 0) + ' magnify=' + (MAGNIFY ? 1 : 0) + ' pre=' + (alreadyConnected ? 1 : 0) + ')');
      rfb = instance;
      rfbReady = false;
      // Replay any keystrokes queued during the reconnect gap once the new RFB
      // is actually connected (sendKey before 'connect' would be dropped).
      try {
        rfb.addEventListener('connect', () => {
          dbg('rfb connect -> ready, flush queue=' + transport.queueLength());
          rfbReady = true;
          // Cold-start cheap, sharpen on settle (see ./kbd/quality.js). Must run
          // BEFORE the typing re-lower below, which stashes the current value.
          quality.beginRefine();
          flushSendQueue();
          kickReconnects();
          fit.resettleOnConnect();
          // Restore fit-to-width rendering on the fresh RFB by re-running the fit
          // dance (see helper). No-op outside fit mode / on first connect.
          reapplyFitOnReconnect();
          // Reconnected mid-typing: the fresh RFB is at its configured quality,
          // so re-apply the typing-time downgrade if the keyboard is still up.
          if (keyboardActive) lowerTypingQuality();
        });
      } catch (_) {}
      // Magnify shows the remote 1:1 (scaleViewport off). resizeSession starts
      // OFF; startMagnify enables it on settle (final size) and freezes it during
      // an active resize burst, so a drag/rotate doesn't realloc the framebuffer
      // ~10x/sec and thrash the encoder. Runs on desktop too.
      if (MAGNIFY) { try { rfb.resizeSession = false; rfb.scaleViewport = false; rfb.clipViewport = false; } catch (_) {} }
      if (isTouch) {
        // Keep noVNC from stealing focus from the proxy input on every tap.
        try { rfb.focusOnClick = false; } catch (_) {}
        setup();
      } else if (DESKTOP) {
        // Desktop: leave focusOnClick TRUE so clicking the canvas (a non-field
        // area) returns key focus to noVNC. The /kbd signal moves focus to the
        // proxy when a remote field is focused.
        setup();
      }
      // Remote -> local copy: mirror the remote page's clipboard to the device
      // via the Clipboard API. DESKTOP only — the clipboard API is intentionally
      // disabled on Android/iOS (no navigator.clipboard writes there).
      if (DESKTOP) { try { rfb.addEventListener('clipboard', onRemoteClipboard); } catch (_) {} }
      if (MAGNIFY) startMagnify();
      // Overlap path (liveview dials while this module graph is still loading): if
      // the handshake ALREADY completed before attach ran, the 'connect' listener
      // above missed the event — so mark the transport ready now, or keystrokes
      // would queue forever. Idempotent with the listener (a late real 'connect'
      // just re-runs this on an empty queue).
      if (alreadyConnected) {
        dbg('attach: pre-connected -> mark ready now');
        rfbReady = true;
        quality.beginRefine(); // same cold-then-sharpen cycle as the listener above
        flushSendQueue();
        kickReconnects();
        fit.resettleOnConnect();
        reapplyFitOnReconnect();
        if (keyboardActive) lowerTypingQuality();
      }
    },
    detach(opts) {
      dbg('detach (' + (opts && opts.soft ? 'soft/reconnect' : 'full') + ', kbd=' + (keyboardActive ? 1 : 0) + ')');
      rfbReady = false;
      // Drop the stashed quality ref without touching the dead rfb; the next
      // RFB reconnects at its configured quality and re-lowers on 'connect' if
      // the keyboard is still up (soft detach keeps it up).
      quality.resetSaved();
      // Same reasoning for the framebuffer scale factor: the next RFB arrives with
      // scaleViewport off, so the factor has to come back to 1 with it.
      fit.resetFbScaleOnDetach();
      rfb = null;
      // A full teardown must not leave a dialog sheet stranded over a dead stream
      // (there is nothing left that could answer it). A SOFT detach keeps it: the
      // remote page is still blocked on that dialog across a 3G blip, and the hub
      // resyncs it on reconnect, so tearing it down would hide a live block.
      // Same rule for the popup close bar: a full teardown must not leave it
      // floating over a dead stream, but a SOFT detach keeps it — the popup is
      // still open on the remote across a 3G blip, and the hub resyncs it on
      // reconnect, so tearing it down would hide the user's only way out.
      if (!(opts && opts.soft)) { dialog.reset(); popupBar.reset(); nativeSelect.reset(); nativePicker.reset(); }
      // Soft detach (auto-reconnect): keep the keyboard up and the proxy focused
      // so a 3G blip doesn't dismiss the keyboard mid-typing. Keys typed during
      // the gap queue and replay on the next 'connect'. The full detach (real
      // teardown) tears the keyboard down.
      if (opts && opts.soft) {
        // Remember the fit zoom so a reconnect-driven re-fit restores it instead
        // of snapping back to the readable default (see pendingFitZoom). On a
        // flapping reconnect (several soft-detaches) the FIRST snapshot wins — a
        // later exitFit could have reset zoomScale — but keep refreshing the
        // timestamp so it stays fresh until the reconnect settles.
        fit.snapshotZoomOnSoftDetach();
        return;
      }
      // Full teardown: cancel the dismiss timers, dismiss the keyboard if up, then
      // WIPE the field-session state + proxy buffer so a later reconnect starts
      // clean — no stale remoteFocusKey/reconFieldKey/lastSentValue leaking a prior
      // field's identity or text into the new session.
      session.clearDismiss();
      session.clearFalseDismiss();
      if (keyboardActive) dismissKeyboard();
      session.resetField();
      clearProxy(); // drops lastSentValue too
      stopWatchdog();
      stopConvergenceWatch();
      fit.stopGeometryWatch();
    },
    toggle: toggleKeyboard,
    preconnectInput() { tc.connectInput(); },
  };
})();
