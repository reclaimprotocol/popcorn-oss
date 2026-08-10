// mock-rfb.mjs — recording stand-in for a noVNC RFB instance.
//
// Records every sendKey(keysym, code, down) call so tests assert on the exact
// keysym stream the input layer produces. `down` semantics mirror noVNC: with
// `down` omitted, sendKey sends press+release (recorded once with down:undefined).
// Includes the pieces of RFB the core touches: addEventListener('connect'|...),
// an optional _sock shaped like noVNC's Websock (so sendBatched exercises its
// flush-suspension path), clipboardPasteFrom, qualityLevel, and the viewer-mode
// flags attach() writes (resizeSession/scaleViewport/clipViewport/focusOnClick).

export function createMockRfb() {
  const keys = [];      // {keysym, code, down}
  const listeners = {}; // event -> [fn]
  const clipboard = []; // clipboardPasteFrom payloads

  const sock = {
    _sQlen: 0,
    _sQbufferSize: 10240,
    flushes: 0,
    flush() { this.flushes++; },
  };

  const pointer = []; // RFB pointer events (x, y, buttonMask)
  const rfb = {
    _sock: sock,
    qualityLevel: 9,
    resizeSession: false,
    scaleViewport: false,
    clipViewport: false,
    focusOnClick: true,
    sendKey(keysym, code, down) { keys.push({ keysym, code, down }); },
    // noVNC's private pointer entry point. The viewer calls it directly for the
    // X11 click used on taps inside cross-origin iframes (kbd/touch-channel.js).
    _handleMouseButton(x, y, mask) { pointer.push({ x: Math.round(x), y: Math.round(y), mask }); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    clipboardPasteFrom(text) { clipboard.push(text); },
    focus() {},

    // ---- test helpers ----
    keys,
    pointer,
    clipboard,
    fireConnect() { for (const fn of (listeners.connect || [])) fn({}); },
    fireClipboard(text) { for (const fn of (listeners.clipboard || [])) fn({ detail: { text } }); },
    // Keysyms of press+release sends only (down === undefined), the shape
    // sendText/sendSpecialKey produce. Chorded sends (explicit down) excluded.
    tapped() { return keys.filter((k) => k.down === undefined).map((k) => k.keysym); },
    // Full down/up sequence for chord assertions: [[keysym, down], ...]
    chords() { return keys.filter((k) => k.down !== undefined).map((k) => [k.keysym, k.down]); },
    clearKeys() { keys.length = 0; clipboard.length = 0; },
  };
  return rfb;
}

// Expected keysym list for a string sent via sendText (codepoint iteration).
export function keysymsFor(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d) { out.push(0xff0d); continue; }
    if (cp === 0x09) { out.push(0xff09); continue; }
    if (cp < 0x20) continue;
    out.push(((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) ? cp : (0x01000000 | cp));
  }
  return out;
}

export const BS = 0xff08, ENTER = 0xff0d, TAB = 0xff09;
