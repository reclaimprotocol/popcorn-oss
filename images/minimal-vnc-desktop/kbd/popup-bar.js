// popup-bar.js — the close affordance for a script-opened popup window.
//
// "Continue with Google" (and payment flows) call window.open, which on the
// remote side is a real second browser window. emulate.go deliberately forces
// that window fullscreen, because a small floating window is unusable on a phone
// viewport — but fullscreening it removes the one control a desktop browser
// gives you for free. Chromium runs --kiosk, so there is no title bar, no tab
// strip and no URL bar: a user who opens the Google sheet and then changes their
// mind has NO way back to the page underneath.
//
// It is worse than a stuck view. The popup lives in the REMOTE browser, so it
// survives a viewer reload — reconnecting shows the same Google page again.
// Without this bar the only exits are completing the sign-in or abandoning the
// session.
//
// So the proxy tells us when a popup is foreground (kbd hub, `popup` state) and
// we draw a close button. The tap sends back only a sequence number; the PROXY
// issues Target.closeTarget, so the viewer never names a target or a CDP method
// — the same server-mediated shape as the dialog reply in kbd/dialog.js.
//
// CLOSE, not hide: the opener is waiting on a postMessage/COOP handoff from that
// window, and a popup that is merely hidden leaves the page spinning forever.
// Closing it is what the OAuth flow already handles — it is the same event the
// user's own "X" produces in a normal browser.
//
// createPopupBar({ sendClose }) — sendClose({seq}) puts the request on the /kbd
// socket. apply(state) is driven by the signal stream.

import { dbg } from './diag.js';
import { SVG_CLOSE } from './ui.js';

// Pinned top-RIGHT, where a window's close button belongs. It does not collide
// with the floating controls (magnify / keyboard / paste): those share the right
// edge but are anchored to the BOTTOM (see CTRL_BASE_BOTTOM), so the top corner
// is free.
//
// Round and icon-only, matching CTRL_BTN_CSS's visual language — the X is the
// universal affordance here, and a text label would only crowd the corner of a
// sign-in page that is already dense.
const BAR_CSS =
  'position:fixed;top:16px;right:16px;width:44px;height:44px;' +
  'box-sizing:border-box;display:none;align-items:center;justify-content:center;' +
  'color:#fff;background:rgba(20,20,20,.6);border-radius:50%;z-index:2147483646;' +
  'box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer;' +
  '-webkit-tap-highlight-color:transparent;user-select:none;';

export function createPopupBar({ sendClose }) {
  let el = null;
  let seq = 0;
  let open = false;

  function ensure() {
    // parentNode, not isConnected: this must also hold for the test DOM stub,
    // where an un-tracked recreate would orphan the node owns() matches against.
    if (el && el.parentNode) return el;
    el = document.createElement('div');
    el.setAttribute('data-popcorn-popup-bar', '1');
    el.style.cssText = BAR_CSS;
    // Icon only, so name it for anyone not seeing the glyph.
    el.setAttribute('aria-label', 'Close window');
    el.setAttribute('title', 'Close window');
    el.setAttribute('role', 'button');
    el.innerHTML = SVG_CLOSE;
    // pointerdown, not click: the tap layer forwards raw touches to the remote,
    // and waiting for a synthesized click would let the touch reach the page
    // underneath first. owns() below keeps the same tap from being forwarded.
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      requestClose();
    });
    document.body.appendChild(el);
    return el;
  }

  function requestClose() {
    if (!open) return;
    dbg('popup close requested seq=' + seq);
    // Do NOT hide the bar here. The popup is only really gone when the remote
    // says so (Target.targetDestroyed -> open:false), and hiding optimistically
    // would strand the user with no button if the request were dropped on a
    // flaky link. Tapping again is harmless: a stale seq is rejected by the proxy.
    try { sendClose({ seq }); } catch (_) {}
  }

  function render() {
    const node = ensure();
    node.style.display = open ? 'flex' : 'none';
  }

  return {
    // apply({open, seq}) — absolute state from the proxy, like every other signal
    // on this socket, so a dropped or reordered frame is self-correcting.
    apply(state) {
      if (!state) return;
      const nextOpen = !!state.open;
      const nextSeq = Number(state.seq) || 0;
      if (nextOpen === open && nextSeq === seq) return;
      open = nextOpen;
      seq = nextSeq;
      dbg('popup state open=' + (open ? 1 : 0) + ' seq=' + seq);
      render();
    },
    // owns(target) — a tap on the bar is the viewer's own chrome, not something
    // to forward to the remote page.
    owns(target) {
      return !!(el && target && (target === el || (el.contains && el.contains(target))));
    },
    isOpen() { return open; },
    reset() {
      open = false;
      seq = 0;
      if (el) el.style.display = 'none';
    },
  };
}
