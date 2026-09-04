// keys.js — keysym encoding, key constants, and deletion math. Pure functions
// and constant tables; no state, no imports. Turns typed text into X11 keysyms
// and counts how many Backspaces a deleted string is worth.

export const SPECIAL_KEYSYMS = { Backspace: 0xff08, Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b };

// Desktop keysym table + modifier keysyms — used by the desktop keysym forwarder
// for every NON-printable or modified key (arrows, Home/End, Delete, F-keys,
// Ctrl/⌘ shortcuts).
export const DESKTOP_KEYSYMS = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Insert: 0xff63, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
};
export const MOD_SHIFT = 0xffe1, MOD_CONTROL = 0xffe3, MOD_ALT = 0xffe9;

// Release both sides of every modifier before injecting text. Xvnc ignores
// releases for keys that are already up.
export const ALL_MODIFIER_KEYSYMS = [
  0xffe1, 0xffe2, // Shift_L, Shift_R
  0xffe3, 0xffe4, // Control_L, Control_R
  0xffe9, 0xffea, // Alt_L, Alt_R
  0xffe7, 0xffe8, // Meta_L, Meta_R
  0xffeb, 0xffec, // Super_L, Super_R
];

// X11 keysym for a Unicode code point (noVNC/keysym convention): Latin-1
// range maps directly, everything else is 0x01000000 | codepoint. TigerVNC's
// Xvnc maps such Unicode keysyms onto a spare keycode on the fly.
export function keysymForCodepoint(cp) {
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 | cp;
}

export function isHighSurrogate(cu) { return cu >= 0xd800 && cu <= 0xdbff; }
export function isLowSurrogate(cu) { return cu >= 0xdc00 && cu <= 0xdfff; }

// One Backspace per UTF-16 code unit matches Blink's per-code-point deletion —
// CORRECT for Indic matras and CJK. But an emoji ZWJ sequence / flag / skin-tone
// / variation-selector is ONE grapheme that Blink deletes with a SINGLE
// Backspace; counting code units there would send extra Backspaces that eat the
// preceding characters.
//
// So segment into grapheme clusters ALWAYS and count per cluster, collapsing a
// cluster to 1 Backspace only when it carries a true pictographic / regional-
// indicator scalar (EMOJI_SCALAR) — else add the cluster's code-unit length.
// The scalar test deliberately EXCLUDES ZWJ (U+200D) and VS16 (U+FE0F): Indic
// scripts use explicit ZWJ conjuncts (Marathi eyelash-ra, deliberate
// Devanagari/Tamil/Bengali/Malayalam joiners), which Blink still deletes per code
// point. The old heuristic keyed on ZWJ/VS presence, so those Indic clusters got
// grapheme-counted and UNDER-deleted, leaving residual characters. Non-emoji
// clusters (all Indic, incl. ZWJ conjuncts) now sum back to deleted.length
// exactly; only real emoji collapse to one Backspace.
let graphemeSeg = null;
try {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    graphemeSeg = new Intl.Segmenter('und', { granularity: 'grapheme' });
  }
} catch (_) { graphemeSeg = null; }
const EMOJI_SCALAR = /[\u{1f000}-\u{1ffff}\u{1f1e6}-\u{1f1ff}\u{2600}-\u{27bf}\u{2b00}-\u{2bff}]/u;
export function backspaceCountFor(deleted) {
  if (!deleted) return 0;
  if (!graphemeSeg) return deleted.length; // no segmenter — per code unit (Indic/CJK safe)
  let n = 0;
  for (const { segment } of graphemeSeg.segment(deleted)) {
    n += EMOJI_SCALAR.test(segment) ? 1 : segment.length;
  }
  return n;
}
