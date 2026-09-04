// desktop-bridge.js — desktop (mouse) keyboard bridge.
//
// On desktop we own the keyboard: the proxy is focused whenever a remote field
// is focused (which silences noVNC — it grabs the CANVAS, so an unfocused
// canvas sends nothing, no double input). Printable text + IME composition go
// through the input/composition handlers; every NON-printable or modified key
// (arrows, Home/End, Delete, F-keys, Ctrl/⌘ shortcuts) is forwarded here as an
// X11 keysym. When no field is focused we hand focus back to the canvas so
// page-level shortcuts and scrolling still reach noVNC.
//
// The clipboard/select-all chords are the exception: they must work with no
// remote field focused, so they capture at the WINDOW — see installDesktopChords.
//
// createDesktopBridge(deps): eventComposing is the CORE's hoisted function (it
// folds per-event composition signals back into the shared isComposing flag —
// pass it, don't reimplement); sendText/sendSpecialKey/clearEcho are core
// aliases wrapped in arrows by the caller where needed.

import {
  DESKTOP_KEYSYMS, MOD_SHIFT, MOD_CONTROL, MOD_ALT, keysymForCodepoint,
} from './keys.js';
import { dbg } from './diag.js';
import { isMacHost } from './env.js';

// macOS Option composes text; forwarding it as Linux Alt triggers browser UI.
// e.key covers Option keyup, where altKey may already be false.
function isOptionCompose(e) {
  return isMacHost && (e.altKey || e.key === 'Alt') && !e.ctrlKey && !e.metaKey;
}

// Windows and Linux use AltGr to enter layout-specific printable characters.
function isAltGraph(e) {
  if (e.key === 'AltGraph') return true;
  try { return !!(e.getModifierState && e.getModifierState('AltGraph')); } catch (_) { return false; }
}

function isLocalCompositionModifier(e) {
  return isOptionCompose(e) || isAltGraph(e);
}

// Unmodified keys that invoke browser UI; modified keys use the allowlist below.
const BROWSER_UI_KEYS = new Set(['f1', 'f3', 'f5', 'f6', 'f10', 'f11', 'f12']);
const COMMAND_MODIFIER_KEYS = new Set(['Control', 'Alt', 'Meta', 'OS']);
const KEY_ACTION = Object.freeze({
  IGNORE: 0,
  BLOCK: 1,
  PASTE: 2,
  TEXT: 3,
  BACKSPACE: 4,
  FORWARD: 5,
  PASS: 6,
});

function keyName(e) {
  return (e.key || '').toLowerCase();
}

function hasCommandModifier(e) {
  return e.ctrlKey || e.metaKey || e.altKey;
}

function hasPrimaryModifier(e) {
  return e.ctrlKey || e.metaKey;
}

function isCommandModifierKey(e) {
  return COMMAND_MODIFIER_KEYS.has(e.key);
}

function isPrintableKey(e) {
  return !!e.key && Array.from(e.key).length === 1;
}

function isIgnoredProxyKey(e) {
  if (e.isComposing || e.keyCode === 229) return true;
  if (isLocalCompositionModifier(e)) return true;
  if (isCommandModifierKey(e) || e.key === 'Shift') return true;
  return false;
}

function isShiftInsertPaste(e) {
  return keyName(e) === 'insert' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
}

function isBrowserUiKey(e) {
  const k = keyName(e);
  return !e.ctrlKey && !e.metaKey && !e.altKey &&
    (BROWSER_UI_KEYS.has(k) || (e.shiftKey && k === 'escape'));
}

export function createDesktopBridge({
  getRfb, getProxy, sendText, sendSpecialKey, eventComposing, applyProxyImeHints, clearEcho,
  onProxyPaste, flushLocalClipboard, releaseRemoteModifiers, requestClipboardPasteFallback,
}) {
  function desktopKeysymFor(e) {
    const k = e.key;
    if (DESKTOP_KEYSYMS[k] != null) return DESKTOP_KEYSYMS[k];
    if (k && Array.from(k).length === 1) return keysymForCodepoint(k.codePointAt(0)); // modified printable
    return 0;
  }

  function requestPasteFallback(e) {
    if (!e.repeat && requestClipboardPasteFallback) requestClipboardPasteFallback();
  }

  function chordLabel(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.metaKey) parts.push('meta');
    if (e.shiftKey) parts.push('shift');
    parts.push(e.key || '');
    return parts.join('+');
  }

  function sendKeyChord(e, keysym) {
    const rfb = getRfb();
    if (!rfb) return;
    const mods = [];
    if (e.shiftKey) mods.push(MOD_SHIFT);
    // macOS ⌘ (metaKey) maps to Control on the Windows remote so ⌘A/⌘C/⌘X work.
    if (e.ctrlKey || e.metaKey) mods.push(MOD_CONTROL);
    if (e.altKey) mods.push(MOD_ALT);
    // Always balance modifier presses, including after a failed send.
    try {
      for (const m of mods) rfb.sendKey(m, null, true);
      rfb.sendKey(keysym, null, true);
      rfb.sendKey(keysym, null, false);
    } catch (_) {
    } finally {
      for (let i = mods.length - 1; i >= 0; i--) {
        try { rfb.sendKey(mods[i], null, false); } catch (_) {}
      }
    }
  }

  function classifyProxyKey(e) {
    if (isIgnoredProxyKey(e)) return KEY_ACTION.IGNORE;
    if (isBrowserUiKey(e)) return KEY_ACTION.BLOCK;
    if (isShiftInsertPaste(e)) return KEY_ACTION.PASTE;
    if (hasCommandModifier(e)) {
      if (!isAllowedEditingChord(e)) return KEY_ACTION.BLOCK;
      return keyName(e) === 'v' ? KEY_ACTION.PASTE : KEY_ACTION.FORWARD;
    }
    if (isPrintableKey(e)) return KEY_ACTION.TEXT;
    return e.key === 'Backspace' ? KEY_ACTION.BACKSPACE : KEY_ACTION.FORWARD;
  }

  function onDesktopKeyDown(e) {
    if (!getRfb()) return;
    const action = classifyProxyKey(e);
    if (action === KEY_ACTION.IGNORE || action === KEY_ACTION.TEXT) return;
    if (action === KEY_ACTION.BLOCK) {
      e.preventDefault();
      dbg('blocked chord (proxy) ' + chordLabel(e));
      return;
    }
    if (action === KEY_ACTION.PASTE) {
      requestPasteFallback(e);
      return;
    }
    const keysym = desktopKeysymFor(e);
    if (!keysym) return;
    e.preventDefault();
    if (action === KEY_ACTION.BACKSPACE) { sendSpecialKey('Backspace'); return; }
    sendKeyChord(e, keysym);
  }

  // Text insertion on desktop: send the committed value, skip while composing
  // (compositionend commits once). Keeps the proxy empty so each keystroke is a
  // fresh delta.
  function onDesktopInput(e) {
    const proxy = getProxy();
    if (!getRfb() || !proxy) return;
    if (eventComposing(e)) return;
    const v = proxy.value;
    if (v) { sendText(v); proxy.value = ''; }
  }

  function focusProxyDesktop() {
    const proxy = getProxy();
    if (!proxy) return;
    // Clear modifiers left down during the canvas-to-proxy focus handoff.
    if (releaseRemoteModifiers) releaseRemoteModifiers();
    applyProxyImeHints();
    try { proxy.removeAttribute('readonly'); } catch (_) {}
    if (document.activeElement !== proxy) {
      try { proxy.focus({ preventScroll: true }); } catch (_) { try { proxy.focus(); } catch (_) {} }
    }
  }
  function blurProxyDesktop() {
    const rfb = getRfb();
    const proxy = getProxy();
    if (proxy && document.activeElement === proxy) { try { proxy.blur(); } catch (_) {} }
    clearEcho();
    // Hand key focus back to noVNC's canvas for page shortcuts / scroll.
    try { if (rfb && rfb.focus) rfb.focus(); } catch (_) {}
  }

  // ---- Window-level clipboard / select-all chords --------------------------
  //
  // The proxy handlers below only run while /kbd reports a focused remote
  // editable, and desktop leaves focusOnClick TRUE — so the usual state is
  // canvas-focused, where noVNC forwards the chord RAW: ⌘A/⌘C/⌘X arrive as
  // Super_L+a/c/x (ignored by the remote) and ⌘V pastes the REMOTE clipboard.
  // Capture at the window instead, ahead of noVNC's canvas listener, and route
  // through sendKeyChord (which is where ⌘ -> Control lives).
  // Default-deny modified keys because Chromium's accelerator set changes.
  // Only text-editing chords reach the remote; page shortcuts such as Ctrl+B do not.
  const EDITING_CHORD_KEYS = new Set([
    'a', 'c', 'x', 'v', 'z', 'y',                    // select/copy/cut/paste/undo/redo
    'arrowleft', 'arrowright', 'home', 'end',         // word/line motion
    'backspace', 'delete', 'insert',                  // word deletion / legacy copy
  ]);
  const SHIFT_BLOCKED_EDITING_KEYS = new Set(['a', 'c', 'x', 'backspace', 'delete']);

  // Shift remains raw for capitalization. Allowed commands synthesize balanced
  // Ctrl/Alt/Meta presses, so bare command modifiers never need forwarding.
  function isAllowedEditingChord(e) {
    const k = keyName(e);
    if (!hasPrimaryModifier(e)) return false;
    if (!EDITING_CHORD_KEYS.has(k)) return false;
    if (e.altKey) return false;
    if (k === 'insert') return e.ctrlKey && !e.metaKey && !e.shiftKey;
    // Reject editing-key combinations that overlap browser commands.
    if (e.shiftKey && SHIFT_BLOCKED_EDITING_KEYS.has(k)) return false;
    return true;
  }

  function classifyWindowKey(e) {
    if (isLocalCompositionModifier(e)) return KEY_ACTION.IGNORE;
    if (isBrowserUiKey(e)) return KEY_ACTION.BLOCK;
    if (isShiftInsertPaste(e)) return KEY_ACTION.PASTE;
    if (!hasCommandModifier(e)) return KEY_ACTION.PASS;
    if (!isAllowedEditingChord(e)) return KEY_ACTION.BLOCK;
    return keyName(e) === 'v' ? KEY_ACTION.PASTE : KEY_ACTION.FORWARD;
  }

  function blockWindowKey(e) {
    if (releaseRemoteModifiers) releaseRemoteModifiers();
    e.preventDefault();
    e.stopImmediatePropagation();
    dbg('blocked chord ' + chordLabel(e));
  }

  function onWindowKeyDown(e) {
    if (!getRfb()) return;
    if (localFieldFocused()) return;
    const action = classifyWindowKey(e);
    if (action === KEY_ACTION.IGNORE || action === KEY_ACTION.PASS) return;
    if (action === KEY_ACTION.BLOCK) { blockWindowKey(e); return; }
    e.stopImmediatePropagation();
    if (action === KEY_ACTION.PASTE) { requestPasteFallback(e); return; }
    e.preventDefault();
    dbg('desktop chord ' + chordLabel(e));
    sendKeyChord(e, desktopKeysymFor(e));
  }

  // Any focused field in OUR document: the proxy (whose own handlers own the
  // chord) or the JS-dialog sheet's prompt input, which is a real local field the
  // user is typing into — stealing its ⌘A/⌘C/⌘V would send them to a remote that
  // is blocked on that very dialog.
  function localFieldFocused() {
    const a = document.activeElement;
    if (!a) return false;
    return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true;
  }

  function installDesktopChords() {
    // Keep local composition modifiers out of noVNC without cancelling text input.
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, (e) => {
        if (!getRfb()) return;
        if (!isLocalCompositionModifier(e)) return;
        dbg('local composition modifier ' + type + ' ' + (e.key || ''));
        e.stopImmediatePropagation();
      }, true);
    }

    // Swallow both edges of bare command modifiers to prevent remote latching.
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, (e) => {
        if (!getRfb()) return;
        if (localFieldFocused()) return;
        if (!isCommandModifierKey(e)) return;
        e.stopImmediatePropagation();
      }, true);
    }

    window.addEventListener('keydown', onWindowKeyDown, true);

    // Canvas-focused ⌘V still fires a paste event; it just had no listener.
    window.addEventListener('paste', (e) => {
      if (!getRfb()) return;
      if (localFieldFocused()) return; // proxy listener, or a real local field
      onProxyPaste(e);
    }, true);

    // writeText rejects when the document isn't focused or activation expired
    // across the ⌘C round-trip. Mouse equivalent of the touch path's onTouchEnd
    // retry. (A cross-origin embed also needs allow="clipboard-write".)
    window.addEventListener('pointerdown', () => { flushLocalClipboard(); }, true);
  }

  return {
    onDesktopKeyDown, onDesktopInput, focusProxyDesktop, blurProxyDesktop,
    installDesktopChords,
  };
}
