// clipboard.js — copy/paste in both directions + the remote key-chords/field-nav
// that ride the same RFB path.
//
//   Local -> remote (PASTE): the user pastes their phone's clipboard into the
//     proxy; we inject it into the focused remote field. On the <input> path a
//     paste would ALSO surface via onProxyInput, so we preventDefault and own it
//     once. The EditContext path gets no automatic paste at all, so this is the
//     only path there.
//   Remote -> local (COPY): when the remote page copies text, noVNC fires a
//     'clipboard' event; we mirror it to the device clipboard.
//
// Also home to sendActionKey (Return-glyph semantics) and navRemoteField (the iOS
// accessory-bar prev/next), which are pure remote-keysym helpers used by the IME
// handlers and the sentinel inputs.
//
// createClipboard(deps) closes over live accessors + the core's send helpers.
// Own state (remoteClipboardText / pendingLocalWrite) lives here.

import { dbg } from './diag.js';
import { nowMs } from './env.js';
import { ALL_MODIFIER_KEYSYMS } from './keys.js';

export function createClipboard({
  getRfb, getProxy, getHints, getFocusKey, sendText, sendSpecialKey,
  clearProxy, setAllowBlur, setKeyboardActive,
}) {
  let remoteClipboardText = null; // latest text the remote copied
  let pendingLocalWrite = false;  // remote text awaiting a user-gesture write
  let pendingSince = 0;
  let pasteGeneration = 0;       // cancels stale/made-redundant fallback reads

  // Prevent stale modifiers from turning injected text into shortcuts.
  function releaseRemoteModifiers() {
    const rfb = getRfb();
    if (!rfb) return;
    for (const keysym of ALL_MODIFIER_KEYSYMS) {
      try { rfb.sendKey(keysym, null, false); } catch (_) {}
    }
  }

  // Ctrl+V on the remote — used to paste a long insert we staged on the remote
  // clipboard in one shot instead of N per-char keysym round-trips.
  function remoteCtrlV() {
    const rfb = getRfb();
    if (!rfb) return;
    // Keysym-only (code=null): with QEMUExtendedKeyEvent negotiated, passing a
    // code string ('KeyV') sends a SCANCODE the server maps through ITS keyboard
    // layout, so on a non-US remote layout the V-position key may not produce
    // 'v' and the paste chord silently does the wrong thing. Sending the bare
    // keysym lets Xvnc pick a keycode that actually yields 'v' — deterministic,
    // layout-independent, and consistent with the rest of the text-injection path.
    // Always release Control, even if a send fails mid-chord.
    try {
      rfb.sendKey(0xffe3, null, true);  // Control down
      rfb.sendKey(0x0076, null, true);  // v down
      rfb.sendKey(0x0076, null, false); // v up
    } catch (_) {
    } finally {
      try { rfb.sendKey(0xffe3, null, false); } catch (_) {} // Control up
    }
  }

  // Shift+Tab on the remote — moves to the PREVIOUS focusable field (plain Tab
  // via sendSpecialKey moves to the next). Used by the iOS accessory-bar arrows.
  function sendShiftTab() {
    const rfb = getRfb();
    if (!rfb) return;
    try {
      rfb.sendKey(0xffe1, 'ShiftLeft', true);  // Shift down
      rfb.sendKey(0xff09, 'Tab', true);        // Tab down
      rfb.sendKey(0xff09, 'Tab', false);       // Tab up
      rfb.sendKey(0xffe1, 'ShiftLeft', false); // Shift up
    } catch (_) {}
  }

  // The action key (Return glyph) means different things per field: a form with
  // enterkeyhint="next"/"previous" wants field navigation, not a submit. Honor
  // that so multi-field forms advance instead of prematurely firing Enter; every
  // other hint (search/go/send/done/none) is a real Enter the remote interprets.
  function sendActionKey() {
    const hints = getHints();
    const ekh = ((hints && hints.enterKeyHint) || '').toLowerCase();
    if (ekh === 'next') { sendSpecialKey('Tab'); return; }
    if (ekh === 'previous') { sendShiftTab(); return; }
    sendSpecialKey('Enter');
  }

  // iOS Safari renders a prev/next (^ v) accessory bar above the keyboard for a
  // focused <input>. Its arrows navigate the LOCAL viewer page, where our proxy
  // is the only field, so they're useless (and would blur→dismiss). We bracket
  // the proxy with two off-screen "sentinel" inputs in tab order; the accessory
  // arrows focus a sentinel, which we translate to Tab / Shift+Tab on the REMOTE
  // form, then hand focus back to the proxy so the keyboard stays up.
  function navRemoteField(dir) {
    if (dir > 0) sendSpecialKey('Tab'); else sendShiftTab();
    // The proxy already blurred (dismissing) when the sentinel took focus; guard
    // the re-focus and restore the up state so the keyboard never actually hides.
    setAllowBlur(true);
    clearProxy();
    const proxy = getProxy();
    try { proxy.focus(); } catch (_) {}
    setKeyboardActive(true);
    setTimeout(() => { setAllowBlur(false); }, 120);
  }

  // True when the server negotiated the Extended Clipboard pseudo-encoding
  // (UTF-8 + zlib Provide). clipboardPasteFrom then transfers text losslessly
  // instead of the legacy ISO-8859-1 clientCutText that maps every codepoint
  // >0xff to '?'. The map keys mirror noVNC's own constants (rfb.js): format
  // Text = 1, action Notify = 1<<27 — exactly what clipboardPasteFrom checks.
  function serverExtendedClipboard() {
    const rfb = getRfb();
    try {
      return !!(rfb && rfb._clipboardServerCapabilitiesFormats &&
        rfb._clipboardServerCapabilitiesFormats[1] &&
        rfb._clipboardServerCapabilitiesActions &&
        rfb._clipboardServerCapabilitiesActions[1 << 27]);
    } catch (_) { return false; }
  }

  function normalizePastedText(text) {
    if (!text) return '';
    const hints = getHints();
    if (hints && hints.tag === 'INPUT') return text.replace(/[\r\n]+/g, '');
    return text;
  }

  function canStageRemoteClipboard(text, rfb) {
    if (typeof rfb.clipboardPasteFrom !== 'function') return false;
    const encodingSupported = /^[\x00-\xff]*$/.test(text) || serverExtendedClipboard();
    if (!encodingSupported) return false;
    return text.length > 32 || !getFocusKey();
  }

  function insertPastedText(text) {
    const rfb = getRfb();
    if (!rfb) return;
    // Single-line field: strip newlines so a pasted trailing \n doesn't fire
    // Enter and instantly submit/navigate. INPUT is the positive test — TEXTAREA
    // and contenteditable report other tags and legitimately keep their newlines.
    text = normalizePastedText(text);
    if (!text) return;
    // Ensure the active paste modifier cannot affect injected text.
    releaseRemoteModifiers();
    // Stage on the remote clipboard + Ctrl+V (one round-trip) instead of per-char
    // keysyms when either:
    //   long text  — a big win over N keysyms on a 3G link;
    //   no known focused field — the desktop window-level ⌘V fires with whatever
    //     the remote has focused, and stray keysyms there would trigger a page's
    //     single-key shortcuts (Gmail/GitHub j/k). Ctrl+V with nothing focused is
    //     simply inert.
    // Safe for pure Latin-1 always, and for ANY text (CJK/emoji) when the server
    // negotiated Extended Clipboard, since clipboardPasteFrom then uses the
    // lossless UTF-8 path instead of the '?'-corrupting ISO-8859-1 fallback.
    // Otherwise fall back to per-char sendText — that text is non-Latin-1, so it
    // cannot trigger an ASCII shortcut either.
    if (canStageRemoteClipboard(text, rfb)) {
      try { rfb.clipboardPasteFrom(text); remoteCtrlV(); return; } catch (_) {}
    }
    sendText(text);
  }

  function onProxyPaste(e) {
    // Any native paste event supersedes the keydown fallback.
    pasteGeneration++;
    if (!getRfb()) return;
    let text = '';
    try {
      const data = e.clipboardData || window.clipboardData;
      text = data.getData('text/plain') || data.getData('text') || '';
    } catch (_) {}
    if (!text) return;
    e.preventDefault();
    dbg('paste len=' + text.length);
    insertPastedText(text);
    clearProxy();
  }

  // Recover when Chromium omits paste during a proxy/canvas focus handoff.
  // Deferring gives the native event priority and prevents duplicate insertion.
  function requestClipboardPasteFallback() {
    const generation = ++pasteGeneration;
    const focusAtRequest = getFocusKey();
    setTimeout(async () => {
      if (generation !== pasteGeneration) return;
      let text = '';
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        text = await navigator.clipboard.readText();
      } catch (_) { return; }
      if (generation !== pasteGeneration || !text) return;
      // A known field must still own focus after the asynchronous read.
      if (focusAtRequest && getFocusKey() !== focusAtRequest) return;
      dbg('paste fallback len=' + text.length);
      insertPastedText(text);
      clearProxy();
    }, 0);
  }

  // writeText needs transient activation on iOS Safari, so a write triggered by
  // the remote's copy (no local gesture) can reject — buffer it and retry on the
  // next tap (onTouchEnd calls flushLocalClipboard).
  function tryWriteLocalClipboard(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => { pendingLocalWrite = false; })
          .catch(() => {});
      }
    } catch (_) {}
  }
  // Bounded: a write that never succeeded must not sit armed and then replace the
  // user's own clipboard on some unrelated gesture minutes later. The retry exists
  // for the next gesture, not for the rest of the session.
  const PENDING_MAX_AGE_MS = 30000;
  function flushLocalClipboard() {
    if (!pendingLocalWrite || !remoteClipboardText) return;
    if (nowMs() - pendingSince > PENDING_MAX_AGE_MS) { pendingLocalWrite = false; return; }
    tryWriteLocalClipboard(remoteClipboardText);
  }
  function onRemoteClipboard(e) {
    const text = e && e.detail && e.detail.text;
    if (!text) return;
    remoteClipboardText = text;
    pendingLocalWrite = true;
    pendingSince = nowMs();
    tryWriteLocalClipboard(text); // best-effort now; retried on next gesture
  }

  return { sendActionKey, insertPastedText, navRemoteField, onProxyPaste, flushLocalClipboard,
    onRemoteClipboard, releaseRemoteModifiers, requestClipboardPasteFallback };
}
