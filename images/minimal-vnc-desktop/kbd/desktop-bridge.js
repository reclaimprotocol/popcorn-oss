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

export function createDesktopBridge({
  getRfb, getProxy, sendText, sendSpecialKey, eventComposing, applyProxyImeHints, clearEcho,
  onProxyPaste, flushLocalClipboard,
}) {
  function desktopKeysymFor(e) {
    const k = e.key;
    if (DESKTOP_KEYSYMS[k] != null) return DESKTOP_KEYSYMS[k];
    if (k && Array.from(k).length === 1) return keysymForCodepoint(k.codePointAt(0)); // modified printable
    return 0;
  }

  function sendKeyChord(e, keysym) {
    const rfb = getRfb();
    if (!rfb) return;
    const mods = [];
    if (e.shiftKey) mods.push(MOD_SHIFT);
    // macOS ⌘ (metaKey) maps to Control on the Windows remote so ⌘A/⌘C/⌘X work.
    if (e.ctrlKey || e.metaKey) mods.push(MOD_CONTROL);
    if (e.altKey) mods.push(MOD_ALT);
    try {
      for (const m of mods) rfb.sendKey(m, null, true);
      rfb.sendKey(keysym, null, true);
      rfb.sendKey(keysym, null, false);
      for (let i = mods.length - 1; i >= 0; i--) rfb.sendKey(mods[i], null, false);
    } catch (_) {}
  }

  function onDesktopKeyDown(e) {
    if (!getRfb()) return;
    if (e.isComposing || e.keyCode === 229) return; // IME owns the key
    const k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return; // bare modifier
    const modified = e.ctrlKey || e.altKey || e.metaKey;
    // Paste shortcut: let the 'paste' event fire so we inject the PHONE clipboard
    // (onProxyPaste), not the remote's — don't forward ⌘V/Ctrl+V to the remote.
    if (modified && (k === 'v' || k === 'V') && (e.ctrlKey || e.metaKey) && !e.altKey) return;
    // Unmodified printable -> produced by input/composition (IME + dead keys).
    if (!modified && k && Array.from(k).length === 1) return;
    const keysym = desktopKeysymFor(e);
    if (!keysym) return;
    e.preventDefault();
    // Plain Backspace goes through sendSpecialKey so the local echo stays in sync.
    if (!modified && k === 'Backspace') { sendSpecialKey('Backspace'); return; }
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
  const CHORD_KEYS = { a: 1, c: 1, x: 1, v: 1 };

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
    window.addEventListener('keydown', (e) => {
      if (!getRfb()) return;
      if (localFieldFocused()) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = (e.key || '').toLowerCase();
      if (!CHORD_KEYS[k]) return;
      e.stopImmediatePropagation(); // keep the raw chord off the wire
      // No preventDefault for V: that would cancel the 'paste' event, which is
      // the only permission-free read of the local clipboard.
      if (k === 'v') return;
      e.preventDefault();
      dbg('desktop chord ' + (e.metaKey ? 'meta' : 'ctrl') + '+' + k);
      sendKeyChord(e, keysymForCodepoint(k.codePointAt(0)));
    }, true);

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
