// field-session.js — the remote-field session: applySignal (the layer's brain),
// input-drift detection, the RTT-adaptive dismiss timer, and ALL the state the
// /kbd focus stream drives (focused-field rect/hints/viewport/rects, focusKey,
// sensitivity, mirror value/seed, drift-recon counters).
//
// State moves WITH its main writer: applySignal is the only writer of nearly
// everything here, so owning both avoids an accessor-splosion. The rest of the
// layer reads through the exposed getters (rect/hints/viewport/inputRects/
// focusKey/sensitive/remoteValue), and the two outside writers come in as
// verbs: armMirrorSeed (raiseKeyboard) and noteSent (transport's recon feed).
//
// createFieldSession(deps) receives the sibling module instances it orchestrates
// (tap, fit, input, echo) plus core lifecycle accessors; raiseKeyboard /
// dismissKeyboard are the core's hoisted declarations.

import { DESKTOP, STATELESS, nowMs } from './env.js';
import { dbg, dbgv } from './diag.js';
import { fieldRejectsSpace } from './ime-hints.js';
import { dismissDelay, linkLatency, noteTapConfirm } from './latency.js';

export function createFieldSession({
  tap, fit, input, echo,
  mirrorOn, seedProxyMirror,
  clearEcho, reconcileEcho, sendSpecialKey,
  applyProxyImeHints, zoomToField, applyLift, currentVisibleBottom,
  focusProxyDesktop, blurProxyDesktop,
  mirrorBarShown, showMirrorBar,
  raiseKeyboard, dismissKeyboard,
  getKeyboardActive, getProxy,
  getManualRaise, setManualRaise, getZoomedToField, setZoomedToField,
}) {
  let currentRect = null;        // focused remote field rect (remote CSS px)
  let currentHints = null;       // {type, inputMode, enterKeyHint, autoComplete}
  let currentViewport = null;    // {w, h} of the remote top-window CSS viewport
  let currentInputRects = [];    // all editable rects (remote CSS px) for hit-testing
  // Rects of CROSS-ORIGIN iframes (remote CSS px). A tap inside one needs a compat
  // mouse click — Chrome does not synthesize `click` from a CDP touch tap inside an
  // out-of-process frame, which is why reCAPTCHA's checkbox ignored taps. See
  // kbd/tap.js and the xf note in extensions/proxy/content.js.
  let currentXFrames = [];
  let lastNonEmptyRectsAt = 0;   // when we last got a populated rect set (flap stickiness)
  const RECTS_STICKY_MS = 3000;  // ignore a transient rects=[] this long after real rects

  // The focusKey (stable per-element identity, from content.js) of the remote's
  // currently-focused editable — null when none. The authoritative recovery
  // raises only when this CHANGES (the remote focused a NEW field), never for a
  // field that was already focused. A local "miss" dismiss doesn't blur the
  // remote, so it keeps reporting the same field's editable:true; keying on
  // focusKey (not a false->true edge or a scroll-fragile rect) means that stale
  // signal can't re-raise the keyboard on every subsequent tap.
  let remoteFocusKey = null;

  let sensitiveField = false;    // remote field is password/OTP/card (sync.sensitive)

  // ?mirror=1 state. remoteValue is the latest field text the extension published
  // (sync.val); mirrorNeedsSeed is set on every raise (a tap targeting a field)
  // and consumed once we have a value to seed with — so a value that arrives late
  // on a slow link still seeds, but only until the user starts typing.
  let remoteValue = '';
  let mirrorNeedsSeed = false;
  const IDLE_RECONCILE_MS = 1500; // pause before the mirror adopts a diverged remote value

  // Input-drift detection: compare the remote field length the extension
  // reports against baseline (length at focus) + net chars we've sent. A
  // divergence means keystrokes were dropped/duplicated in transit.
  let reconEnabled = false;      // non-sensitive field with a known length
  let reconFieldKey = null;      // identity (rect+hints) of the tracked field
  let baselineLen = 0;           // remote length when the field gained focus
  let sentDelta = 0;             // net code points sent since focus

  let dismissTimer = null;       // RTT-adaptive dismiss-if-not-editable timer

  function armDismiss() {
    clearDismiss();
    dismissTimer = setTimeout(() => { dismissTimer = null; dismissKeyboard(); }, dismissDelay());
  }

  function clearDismiss() {
    if (dismissTimer !== null) { clearTimeout(dismissTimer); dismissTimer = null; }
  }


  // Compare the reported remote field length against baseline+sentDelta. On a
  // new field, (re)baseline. On divergence, surface it and resync the baseline
  // (so it doesn't refire every report). We deliberately do NOT auto-rewrite:
  // the viewer doesn't know the field's pre-existing/autofilled content, so a
  // rewrite could clobber it, and shipping field content across /kbd would leak
  // it to other viewers. Detection here lets a portal warn/retry safely.
  function detectDrift(state) {
    const sync = state.sync || {};
    // Prefer the stable focusKey; fall back to rect+hints for older extensions.
    const fieldKey = state.focusKey || JSON.stringify([state.rect, state.hints]);
    if (fieldKey !== reconFieldKey) {
      reconFieldKey = fieldKey;
      sentDelta = 0;
      baselineLen = (typeof sync.len === 'number') ? sync.len : 0;
      reconEnabled = !sync.sensitive && typeof sync.len === 'number';
      return;
    }
    if (!reconEnabled || typeof sync.len !== 'number') return;
    const expected = baselineLen + sentDelta;
    if (sync.len !== expected) {
      try { console.warn('[kbd] input drift: remote len', sync.len, 'expected', expected); } catch (_) {}
      try {
        window.parent.postMessage({ type: 'POPCORN_INPUT_DRIFT', remoteLen: sync.len, expectedLen: expected }, '*');
      } catch (_) {}
      baselineLen = sync.len - sentDelta; // resync to reality
    }
  }

  // ---- address-field trailing-space repair ----------------------------------
  // Tapping a Gboard suggestion in an email/username field commits the word PLUS a
  // trailing space. The space is invisible in the field and the site rejects a
  // perfectly good address ("incorrect email or password") — one backspace made
  // the identical login succeed, which is how this was found.
  //
  // Every send path (EditContext textupdate, the Android value-diff, the iOS
  // beforeinput batch, compositionend) funnels through transport.sendText, which
  // already drops a space on these fields — and instrumentation proved no send
  // ever carries one. So the space does NOT originate from a keystroke we
  // transmit: the remote page's own IME/autofill puts it there. No send-side
  // filter can catch that, so repair it from the only authoritative source we
  // have — sync.val, the field's real text as the extension reports it.
  //
  // Safe because it is scoped to fields where a trailing space is never valid
  // (fieldRejectsSpace: type/inputmode/autocomplete/name/placeholder say address,
  // and never a textarea or a password — passphrase spaces are legal), and only
  // while WE own the field. Bounded per field so a page that re-adds the space
  // can't turn this into a backspace loop.
  const SPACE_REPAIR_IDLE_MS = 350; // let an in-flight burst land before judging val
  const SPACE_REPAIR_MAX = 3;
  let spaceRepairKey = null;
  let spaceRepairs = 0;

  function repairTrailingSpace(state, sync) {
    // Shape of the authoritative value on every signal for a field we're typing
    // into, plus which gate stopped a repair. Lengths and flags only, never
    // content. This is what turns "still same" into a decidable question: either
    // val doesn't end in a space (the space isn't in the field at all) or a
    // specific guard is wrong.
    const hasVal = typeof sync.val === 'string';
    const ours = getKeyboardActive() || document.activeElement === getProxy();
    if (hasVal && ours) {
      const shape = 'vlen=' + sync.val.length + ' tail=' + (/ $/.test(sync.val) ? 1 : 0) +
        ' ns=' + (fieldRejectsSpace() ? 1 : 0) + ' sens=' + (sensitiveField ? 1 : 0) +
        ' comp=' + (input.composing() ? 1 : 0) + ' echo=' + (echo.hasText() ? 1 : 0) +
        ' idle=' + Math.round(nowMs() - input.lastInputAt()) + ' n=' + spaceRepairs;
      // A trailing space that we then DON'T repair is the whole bug, so that case
      // is worth a normal-tier line (rare by construction); everything else is
      // verbose. Lengths and flags only, never content.
      if (/ $/.test(sync.val)) dbg('sp! ' + shape); else dbgv('sp? ' + shape);
    }
    if (sensitiveField || !fieldRejectsSpace()) return;
    if (!hasVal || !/ $/.test(sync.val)) return;
    // Only a field we're actually typing into (touch latches keyboardActive;
    // desktop keeps the proxy focused).
    if (!getKeyboardActive() && document.activeElement !== getProxy()) return;
    // Never mid-composition (the value write below would cancel the IME), and not
    // while keystrokes are still unconfirmed — val would be stale and the space
    // might be one we're about to overwrite anyway.
    if (input.composing() || echo.hasText()) return;
    if (nowMs() - input.lastInputAt() < SPACE_REPAIR_IDLE_MS) return;
    const key = state.focusKey || null;
    if (key !== spaceRepairKey) { spaceRepairKey = key; spaceRepairs = 0; }
    if (spaceRepairs >= SPACE_REPAIR_MAX) return;
    spaceRepairs++;
    dbg('trailing-space repair vlen=' + sync.val.length + ' try=' + spaceRepairs);
    sendSpecialKey('Backspace');
    // Keep our local baseline in step with the remote we just edited, or the next
    // diff re-adds the space (mirror: the proxy holds the whole field, so adopt
    // the trimmed text; otherwise the proxy holds only the current word, and a
    // word-boundary reset is what makes the following keystrokes append cleanly).
    const trimmed = sync.val.slice(0, -1);
    remoteValue = trimmed;
    if (mirrorOn()) input.adoptRemoteValue(trimmed);
    else input.clearProxy();
  }

  // Grace window for a transient editable:false. Pages that blur field A then
  // async-focus field B (validation-on-blur, framework re-render, custom widgets)
  // emit false between two trues; dismissing on the false yanks the keyboard down
  // and the follow-up true can't re-raise in-gesture (iOS fails, Android
  // flickers). Debounce the dismiss so a returning true cancels it. Fixed, NOT
  // RTT-scaled — a slow-link scale would make genuine dismisses feel sticky.
  const FALSE_DISMISS_GRACE_MS = 350;
  let pendingFalseDismiss = null;
  function clearFalseDismiss() {
    if (pendingFalseDismiss !== null) { clearTimeout(pendingFalseDismiss); pendingFalseDismiss = null; }
  }

  // Full field-gone teardown: forget the tracked field's identity, drift
  // baseline, sensitivity, mirror value, and unconfirmed echo. Used on a
  // confirmed editable=false AND on a full detach (via the exposed verb), so a
  // reconnect never inherits a prior field's identity or text.
  function resetField() {
    currentRect = null;
    reconEnabled = false;
    reconFieldKey = null;
    remoteFocusKey = null;
    echo.setAllowed(false);
    sensitiveField = false;
    remoteValue = ''; mirrorNeedsSeed = false;
    spaceRepairKey = null; spaceRepairs = 0;
    clearEcho();
  }

  function applySignal(state) {
    if (!state || typeof state.editable !== 'boolean') return;
    // Skip idle editable=false heartbeats so the panel keeps meaningful lines.
    if (state.editable || getKeyboardActive()) {
      dbg('SIG editable=' + state.editable + ' fk=' + (state.focusKey || '-') +
          ' kbd=' + getKeyboardActive() + ' dtap=' + (tap.lastTapAt() ? Math.round(nowMs() - tap.lastTapAt()) : '-') +
          ' rects=' + (Array.isArray(state.rects) ? state.rects.length : '?') +
          // Whether the authoritative field text is reaching us at all, and its
          // length — the trailing-space repair is blind without it. Length only.
          ' val=' + (state.sync && typeof state.sync.val === 'string' ? state.sync.val.length : '-'));
    }

    // rects/viewport ride on every message (editable or not) — keep them fresh
    // for the tap hit-test regardless of focus state.
    //
    // STICKY against flapping: some remote pages (and the frame-merge under a
    // racy heartbeat) briefly emit rects=[] between two populated reports. On a
    // high-latency link that empty window is wide, and a tap landing in it finds
    // no fields → the hit-test says 'unknown' and the keyboard never comes up
    // ("tapping a field does nothing"). So ignore a transient empty update while
    // we recently had real rects; accept the clear only once it persists past
    // RECTS_STICKY_MS (a genuinely input-less page) or after a navigation (the
    // pid block below zeroes lastNonEmptyRectsAt so the new page's empty sticks).
    if (Array.isArray(state.rects)) {
      if (state.rects.length > 0) {
        currentInputRects = state.rects;
        lastNonEmptyRectsAt = nowMs();
      } else if (nowMs() - lastNonEmptyRectsAt >= RECTS_STICKY_MS) {
        currentInputRects = state.rects; // sustained empty → accept the clear
      } // else: keep the last non-empty rects through the transient flap
    }
    if (Array.isArray(state.xf)) currentXFrames = state.xf;
    if (state.vw > 0 && state.vh > 0) currentViewport = { w: state.vw, h: state.vh };

    // Fit-to-width detection + navigation handling (top document only) lives in
    // ./kbd/fit.js — it also zeroes the rect stickiness on a real nav (onNavChanged).
    fit.handleTopDocSignal(state);

    if (state.editable) {
      const curKey = state.focusKey || null;
      // A different field is focused than the one we last saw. Covers the
      // false->editable case too (remoteFocusKey is null when nothing was
      // focused), so this is the single "the remote focused a NEW field" test.
      const isNewField = curKey !== remoteFocusKey;
      currentRect = state.rect || null;
      currentHints = state.hints || null;
      detectDrift(state);
      clearDismiss(); // confirmed an input — keep the keyboard up
      clearFalseDismiss(); // a true cancels a debounced transient-blur dismiss
      setManualRaise(false); // real field focused — normal dismiss logic governs now
      // Local-echo bookkeeping (detectDrift has just refreshed baseline/delta):
      const sync = state.sync || {};
      echo.setAllowed(!(sync && sync.sensitive)); // never echo password/OTP/card
      sensitiveField = !!(sync && sync.sensitive); // gate auto-space + Indic guess
      // Mirror: track the remote field's real text. A new field resets it (a
      // sensitive field publishes no val, so it stays empty and is never seeded).
      if (typeof sync.val === 'string') remoteValue = sync.val;
      else if (isNewField) remoteValue = '';
      // Clean slate on a remote-driven field switch. When the page moves focus
      // from field A to a DIFFERENT field B while the keyboard stays up (OTP /
      // checkout auto-advance, framework re-render/validation-on-blur), the proxy
      // still holds A's buffer, so B's first edit diffs against A's leftover text
      // and corrupts it (chars from A prepended, or a spurious backspace run).
      // remoteFocusKey!==null means a prior field was being tracked, so this is a
      // genuine switch — NOT the first confirm after a tap-raise (remoteFocusKey is
      // null then, and that path already reset the buffer AND the user may have
      // typed ahead into it, so clearing there would eat their input). Mirror on:
      // mark for reseed so the seed block below repopulates the proxy from B's real
      // value. Mirror off: we don't know B's text, so wipe the stale buffer
      // (proxy.value / EC buffer + lastSentValue). Never mid-composition (a value
      // write cancels the IME); the guard skips a no-op clear on an empty buffer.
      if (isNewField && remoteFocusKey !== null && getKeyboardActive() && !input.composing()) {
        if (mirrorOn()) mirrorNeedsSeed = true;
        else if (input.lastSentValue() || input.ecMode() || (getProxy() && getProxy().value)) input.clearProxy();
      }
      if (isNewField) clearEcho();              // fresh field, fresh echo
      else if (!echo.allowed()) clearEcho();
      else {
        // Trim the leading chars the remote has now confirmed so the pill shows
        // only the still-in-flight tail (not the whole typed-ahead wall). Advance
        // baseline/sentDelta in lockstep — their SUM (the drift "expected") is
        // unchanged, so the NEXT frame's confirmed count is incremental, not
        // cumulative; otherwise a repeated same-len frame would eat live chars.
        if (reconEnabled && typeof sync.len === 'number') {
          const confirmed = Math.max(0, Math.min(sync.len - baselineLen, echo.textLen()));
          if (confirmed > 0) { reconcileEcho(confirmed); baselineLen += confirmed; sentDelta -= confirmed; }
        }
        // Safety net: clear whatever's still unconfirmed after an RTT-scaled
        // window (never below the old 8s floor, grows on slow links, capped 15s)
        // so a lost confirm or drift can't strand the pill.
        if (echo.hasText() && nowMs() - echo.lastAt() > Math.min(15000, Math.max(8000, 4 * linkLatency()))) reconcileEcho();
      }
      if (isNewField) {
        // Learn tap -> confirm latency to size the dismiss window.
        if (tap.lastTapAt()) {
          const observed = nowMs() - tap.lastTapAt();
          if (observed > 0 && observed < 8000) noteTapConfirm(observed);
        }
        // Reshape the proxy IME for the new field — including field-to-field
        // tabbing while the keyboard stays up (text -> number should switch
        // Gboard to a numeric pad).
        applyProxyImeHints();
      }
      // Whole-page desktop-fit (novp): mirror mobile Safari — once the keyboard is
      // up on a field, zoom into it so it's readable (the field is often
      // auto-focused, so this can't gate on isNewField). Re-zooms per new field.
      if (isNewField) setZoomedToField(false);
      // Only for a fit whose whole-width overview is genuinely UNREADABLE. The
      // 980px desktop-fallback is that case — zooming into the field is the only
      // way to type. A narrow fit is not: ?fixedw=560 and the olw left-clip fit
      // (412) are both readable as the overview, so an automatic zoom to
      // minZoom*1.5 throws away the whole-width view the mode exists to give, per
      // field and unprompted. On the olw fit it is actively wrong — that fit exists
      // to bring a clipped EDGE into view, and zooming puts it straight back out.
      //
      // fit.fieldZoomWorthwhile() decides this from the fit's own downscale ratio
      // (see FIELD_ZOOM_RATIO). It replaces a `!fixedFit()` special case that keyed
      // on which BRANCH produced the fit, so each new narrow fit had to remember to
      // opt out — and the olw path did not, which is exactly how tapping a field on
      // Pinterest started zooming.
      //
      // Skipping the zoom hands the job back to applyLift (suppressed only while
      // zoomedToField), so the field still clears the keyboard; it just does so
      // without changing zoom.
      if (fit.fieldZoomWorthwhile() && !fit.wantReadable() && getKeyboardActive() && !getZoomedToField() && state.rect) {
        setZoomedToField(true);
        zoomToField(state.rect);
      }
      // Seed the mirror once the real value arrives. On a slow link the tap raised
      // (and seeded '') seconds before this confirm; seed now that we know the
      // text — but only while awaiting seed (mirrorNeedsSeed), the proxy holds
      // focus, and nothing is composing, so we never clobber text the user has
      // already begun typing (onProxyInput clears the flag on the first edit).
      if (mirrorNeedsSeed && mirrorOn() && !input.composing() && document.activeElement === getProxy()) {
        seedProxyMirror();
      }
      // Idle drift-repair (follow-up #1): once the user pauses AND the remote is
      // not behind, adopt the remote's real value if it diverged from ours — the
      // remote field is the source of truth (remote-side autofill / framework
      // mutation, or a same-length substitution the value-diff couldn't see). This
      // turns the old warn-only drift detection into an actual repair.
      //
      // Guarded hard so we never destroy good input: only when NOT awaiting seed,
      // NOT composing (a value write would cancel the IME), the proxy is focused,
      // the user has been idle > IDLE_RECONCILE_MS, and the remote holds AT LEAST
      // as many chars as we think we sent. That last test is the safety: a shorter
      // remote value means our keystrokes are still in flight on a slow link (not
      // real drift), so snapping down would erase text the user correctly typed.
      // (Forward-repair of genuinely dropped keystrokes — remote shorter — is a
      // separate, harder item; not attempted here.)
      else if (mirrorOn() && !input.composing() && document.activeElement === getProxy() &&
               typeof sync.val === 'string' && sync.val !== input.lastSentValue() &&
               sync.val.length >= input.lastSentValue().length &&
               nowMs() - input.lastInputAt() > IDLE_RECONCILE_MS) {
        input.adoptRemoteValue(sync.val); // remote is authoritative now
        clearEcho(); // drop any stale unconfirmed echo
      }
      // Independent of mirror mode — the Gboard suggestion space lands on the
      // Android value-diff/EditContext paths, which are the default.
      repairTrailingSpace(state, sync);
      // Authoritative recovery: the remote focused a NEW editable in response to
      // a tap, but our local hit-test missed its rect (cross-origin / closed
      // shadow / imperfect coordinate mapping). Raise now. Keyed on focusKey: a
      // field that was ALREADY focused keeps emitting editable:true after a
      // local "miss" dismiss (which doesn't blur the remote), and its unchanged
      // focusKey makes isNewField=false — so that stale signal can't re-raise
      // the keyboard on every subsequent tap, input or not.
      //
      // The window is RTT-adaptive: a fixed 1500ms expires before the confirm
      // arrives on any link slower than ~1.5s RTT (3G), so the keyboard would
      // NEVER recover there. dismissDelay() already tracks tap->confirm latency
      // (emaLatency*2.5+400, clamped to 5s); reuse it so the accept window grows
      // with the measured link, never shrinking below the 1500ms default.
      if (STATELESS) {
        // Advisory-only: never re-raise from /kbd. The tap already raised
        // optimistically (handleTap), so a delayed remote confirm adds nothing but
        // thrash on a slow link.
      } else if (!getKeyboardActive() && isNewField && !tap.lastTapWasMiss() && tap.lastTapAt() && (nowMs() - tap.lastTapAt()) < Math.max(1500, dismissDelay())) {
        dbg('recovery raise (newField, dtap=' + Math.round(nowMs() - tap.lastTapAt()) + 'ms, win=' + Math.round(Math.max(1500, dismissDelay())) + ')');
        raiseKeyboard('recovery');
      } else if (!getKeyboardActive() && isNewField && tap.lastTapWasMiss()) {
        dbg('recovery raise SUPPRESSED (last tap was a confirmed non-input; ambient focus flap)');
      }
      // Desktop: no soft keyboard — just move key focus to the proxy so IME +
      // our keysym forwarder handle input (silencing noVNC's canvas grab).
      if (DESKTOP) focusProxyDesktop();
      remoteFocusKey = curKey;
      if (getKeyboardActive()) applyLift(currentVisibleBottom());
      // Belt-and-suspenders: if the keyboard rose without going through
      // raiseKeyboard (already-focused field, some re-raise paths), still promote
      // the bar. Guarded so it only fires once and never logs SKIP spam.
      if (mirrorOn() && getKeyboardActive() && !mirrorBarShown()) showMirrorBar();
    } else {
      if (DESKTOP) blurProxyDesktop(); // desktop: hand keys back immediately
      if (getKeyboardActive() && (getManualRaise() || STATELESS)) {
        // STATELESS: /kbd is advisory — a stale editable=false never dismisses the
        // keyboard (that's the flap-driven thrash we're eliminating). Only a real
        // local event (button, system blur, viewport grow) dismisses.
        // manualRaise: escape-hatch raise on a field we can't focus remotely, so
        // editable=false is EXPECTED — don't dismiss until a real field is focused
        // or the user dismisses. Either way, keep rects fresh (done above).
      } else if (getKeyboardActive() && dismissTimer !== null && !remoteFocusKey &&
                 tap.lastTapAt() && (nowMs() - tap.lastTapAt()) < Math.max(1500, dismissDelay())) {
        // An optimistic tap-raise is still awaiting its FIRST editable:true (armed
        // dismissTimer, no confirmed field yet, tap still inside the RTT-adaptive
        // confirm window). A stale editable:false landing now must NOT fire the
        // fixed 350ms grace — on 3G that fires long before the real confirm and
        // tears the just-opened keyboard back down. Let armDismiss's RTT-adaptive
        // timer own teardown instead; the confirm (if any) cancels it via clearDismiss.
        dbg('editable=false during optimistic-raise confirm window -> defer to armDismiss');
      } else if (getKeyboardActive()) {
        // Keyboard is up — protect it. Debounce the dismiss and the state teardown
        // so a field-to-field blur→focus (a true within the grace) is seamless.
        // Keep currentRect/remoteFocusKey INTACT during the grace so a returning
        // true is treated correctly; only tear down if no true arrives.
        if (pendingFalseDismiss === null) {
          dbg('editable=false while kbd up -> grace-debounce dismiss (' + FALSE_DISMISS_GRACE_MS + 'ms)');
          pendingFalseDismiss = setTimeout(() => {
            pendingFalseDismiss = null;
            dbg('grace elapsed, no re-focus -> dismiss');
            resetField();
            dismissKeyboard();
          }, FALSE_DISMISS_GRACE_MS);
        }
      } else {
        // Keyboard already down — nothing to protect, tear down immediately.
        resetField();
      }
    }
  }


  return {
    applySignal, armDismiss, clearDismiss, clearFalseDismiss, resetField,

    // recon feed from the transport (+typed codepoints / -backspaces)
    noteSent(delta) { if (reconEnabled) sentDelta += delta; },

    // raiseKeyboard: every raise is a fresh tap on a field — (re)seed the mirror
    armMirrorSeed() { mirrorNeedsSeed = true; },

    // fit's onNavChanged: a real navigation drops the rect-flap stickiness so
    // the new page's empty/refreshed rect set takes effect immediately.
    clearRectStickiness() { lastNonEmptyRectsAt = 0; },

    // getters for the rest of the layer
    rect: () => currentRect,
    hints: () => currentHints,
    viewport: () => currentViewport,
    inputRects: () => currentInputRects,
    xframes: () => currentXFrames,
    lastNonEmptyRectsAt: () => lastNonEmptyRectsAt,
    focusKey: () => remoteFocusKey,
    sensitive: () => sensitiveField,
    remoteValue: () => remoteValue,
    consumeMirrorSeed() { mirrorNeedsSeed = false; },
  };
}
