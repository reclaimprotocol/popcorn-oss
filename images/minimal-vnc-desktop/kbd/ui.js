// ui.js — static visual constants for the mobile keyboard layer.
//
// Pure strings only (inline SVG icons, floating-control CSS, the hidden proxy's
// base style). No state, no imports; a leaf of the kbd/ module graph. The Unicode
// glyphs (⌕ ⤡ ⌨) render as tofu boxes on iOS Safari, so the icons are drawn as
// inline SVG (currentColor via stroke).

// Floating zoom / keyboard / paste button icons.
export const SVG_ZOOM_IN = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="21" y2="21"/><line x1="10.5" y1="7.5" x2="10.5" y2="13.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/></svg>';
export const SVG_ZOOM_OUT = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="21" y2="21"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/></svg>';
export const SVG_KBD = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6.5" width="19" height="11" rx="2"/><line x1="6" y1="10.2" x2="6.01" y2="10.2"/><line x1="9.5" y1="10.2" x2="9.51" y2="10.2"/><line x1="13" y1="10.2" x2="13.01" y2="10.2"/><line x1="16.5" y1="10.2" x2="16.51" y2="10.2"/><line x1="8" y1="14" x2="16" y2="14"/></svg>';
export const SVG_PASTE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 4.5a3 3 0 0 1 6 0"/><line x1="9" y1="10.5" x2="15" y2="10.5"/><line x1="9" y1="14.5" x2="15" y2="14.5"/></svg>';

// Close icon for the popup close button (see kbd/popup-bar.js). Stroked, like the
// others, so it inherits the same weight as the floating controls.
export const SVG_CLOSE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

// Shared base style for the round floating controls (magnify / keyboard / paste).
// Per-button `bottom` and `display` are set by the caller.
export const CTRL_BTN_CSS = 'position:fixed;right:16px;width:44px;height:44px;' +
  'box-sizing:border-box;display:flex;align-items:center;justify-content:center;' +
  'font:400 22px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;' +
  'background:rgba(20,20,20,.6);border-radius:50%;z-index:2147483646;' +
  'box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer;' +
  '-webkit-tap-highlight-color:transparent;user-select:none;';

// The hidden proxy <input>/<div> style. Must stay visually interactive (rendered,
// on-screen, non-zero opacity): iOS only raises the keyboard for an interactive
// element, so NO pointer-events:none and opacity:0.01 not 0. 40x20 + 16px font so
// Samsung Keyboard / SwiftKey attach and iOS doesn't zoom. moveProxyTo() relocates
// it under the finger on each tap so its hit-area isn't a center dead-zone. Do NOT
// add user-select:none — on iOS that makes an editable input refuse text.
export const PROXY_STYLE =
  'position:fixed;top:50%;left:50%;width:40px;height:20px;opacity:0.01;' +
  'font-size:16px;border:0;outline:0;padding:0;margin:0;background:transparent;' +
  'color:transparent;caret-color:transparent;z-index:2147483647;' +
  '-webkit-touch-callout:none;';
