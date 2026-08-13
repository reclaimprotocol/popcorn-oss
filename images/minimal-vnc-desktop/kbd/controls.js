// controls.js — the floating control buttons (magnify/fit toggle, keyboard
// toggle, paste) and their visibility policy.
//
// The zoom and keyboard-toggle buttons belong to the no-keyboard state, so they
// HIDE while the keyboard is up (pinned to the window bottom, they'd otherwise
// sit on top of the keys). The paste button is the opposite — shown only with
// the keyboard up, and lifted to just above the keyboard's top edge so it stays
// reachable and clear of the keys. That lift needs the keyboard's HEIGHT, which a
// cross-origin iframe cannot measure for itself, so host-reported geometry is
// preferred over the local visualViewport read (see keyboardInset).
//
// createControls(deps): raiseKeyboard / dismissKeyboard / focusClosestInput are
// the core's hoisted function declarations (passed directly); isZoomed /
// toggleMagnify come from the viewport-transform instance (created earlier);
// setAllowBlur / setKeyboardActive are the same setter-injection shape
// clipboard.js uses (pasteFromDevice WRITES that core state).

import { dbg } from './diag.js';
import { nowMs } from './env.js';
import { hostGeometry } from './host-bridge.js';
import { SVG_ZOOM_IN, SVG_ZOOM_OUT, SVG_KBD, SVG_PASTE, CTRL_BTN_CSS } from './ui.js';

// ---- draggable-group geometry (pure, unit-tested) ----------------------------
// The buttons are DRAGGABLE because they are pinned over the bottom corner of the
// remote page — which is exactly where "Sign in" / "Continue" buttons live, and a
// 44px circle there can make a real control unreachable. Dragging any one of them
// moves the whole cluster (they are one control group; scattering them individually
// would be worse), and on release the group snaps to the nearer side like iOS
// AssistiveTouch, so it can never come to rest mid-content.

// Base `bottom` for each button when the group has not been moved. The paste
// button's bottom is additionally keyboard-driven (see updateControlButtons).
export const CTRL_BASE_BOTTOM = { mag: 70, kbd: 16, paste: 124 };
// Movement under this (CSS px) is a tap, not a drag — a finger never holds
// perfectly still on a 44px target.
export const DRAG_SLOP = 8;
// After a real drag, swallow the click the same gesture would otherwise fire.
const DRAG_CLICK_SUPPRESS_MS = 400;

/**
 * Clamp the group's vertical offset so every button stays fully on screen.
 * `lift` is px ABOVE each button's base bottom (dragging up increases it).
 */
export function clampCtrlLift(lift, viewportH) {
  // The topmost button in the stack is the constraint: base 124 + lift + 44 tall
  // must stay inside the viewport, with a small margin.
  const maxLift = Math.max(0, (viewportH || 0) - CTRL_BASE_BOTTOM.paste - 44 - 8);
  if (!isFinite(lift) || lift < 0) return 0;
  return Math.min(lift, maxLift);
}

/** Which side the group snaps to, from the release X. */
export function snapCtrlSide(releaseX, viewportW) {
  return releaseX < (viewportW || 0) / 2 ? 'left' : 'right';
}

// Gap between the keyboard's top edge and the paste button.
const PASTE_KBD_GAP = 12;

/**
 * How many px the soft keyboard covers at the bottom of OUR viewport.
 *
 * `hostGeom` (when the embedder is feeding geometry) wins outright: inside a
 * cross-origin iframe our own visualViewport does not shrink for the keyboard, so
 * the local measurement below reads 0 and the paste button lands ON the keys —
 * which is the whole reason the host bridge exists. The embedder is top-level, so
 * its number is authoritative, and it uses the same formula, so the two branches
 * mean the same thing.
 *
 * Locally: with an OVERLAY keyboard innerHeight stays full and this difference is
 * the keyboard height. When the browser instead shrinks the layout viewport for
 * the keyboard (Samsung Internet), the difference is ~0 — correctly, because the
 * viewport bottom already sits at the keyboard's top edge. Deliberately not
 * currentVisibleBottom(), whose VK-API branch double-counts in that second case
 * and shot the button to the top of the screen.
 */
export function keyboardInset(hostGeom, win) {
  if (hostGeom && isFinite(hostGeom.occludedBottom)) return Math.max(0, hostGeom.occludedBottom);
  const vv = win && win.visualViewport;
  if (!vv) return 0;
  return Math.max(0, win.innerHeight - vv.height - vv.offsetTop);
}

/** Resting `bottom` for the paste button while the keyboard is up. */
export function ctrlPasteBottom(inset, lift) {
  return Math.max(CTRL_BASE_BOTTOM.kbd, inset + PASTE_KBD_GAP) + (lift || 0);
}

export function createControls({
  getKeyboardActive, isZoomed, toggleMagnify,
  raiseKeyboard, dismissKeyboard, focusClosestInput, getRemoteFocusKey,
  insertPastedText, getProxy, setAllowBlur, setKeyboardActive,
}) {
  let magBtn = null;
  let kbdBtn = null;
  let pasteBtn = null;
  let magEligible = false; // this page wants the zoom/fit button (set by enter/exitFit)

  // ---- draggable group state ---------------------------------------------------
  let groupSide = 'right';        // snapped side; 'left' after a drag past centre
  let groupLift = 0;              // px above the base bottoms
  let suppressClickUntil = 0;     // a drag must not also fire the button's action
  const POS_KEY = 'pcnCtrlPos';

  // Remember where the user parked the controls, so it survives a reconnect (which
  // rebuilds the buttons) and the next session on the same device. Best-effort:
  // Safari private mode throws on localStorage.
  function loadPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && (p.side === 'left' || p.side === 'right')) groupSide = p.side;
      if (p && isFinite(p.lift)) groupLift = clampCtrlLift(Number(p.lift), window.innerHeight);
    } catch (_) {}
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ side: groupSide, lift: groupLift })); } catch (_) {}
  }

  // Apply the group's side to a button. Vertical placement stays with
  // updateControlButtons, which is the single owner of `bottom` (it also has to
  // account for the keyboard for the paste button).
  function applySide(el) {
    if (!el) return;
    if (groupSide === 'left') { el.style.right = 'auto'; el.style.left = '16px'; }
    else { el.style.left = 'auto'; el.style.right = '16px'; }
  }

  /**
   * Make a floating button drag the whole group. Touch-only: these buttons are
   * created only on touch devices. Uses its own listeners on the button rather than
   * the document-level gesture layer, which already ignores them (onMagButton).
   */
  function makeDraggable(el) {
    if (!el) return;
    let start = null;
    let lastX = 0;
    el.addEventListener('touchstart', (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      start = { x: t.clientX, y: t.clientY, lift: groupLift, moved: false };
      lastX = t.clientX;
      e.stopPropagation(); // never let a control drag reach the stream
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches && e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!start.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
      start.moved = true;
      lastX = t.clientX;
      // Dragging UP (negative dy) raises the group, hence the subtraction.
      groupLift = clampCtrlLift(start.lift - dy, window.innerHeight);
      updateControlButtons();
      e.stopPropagation();
      if (e.cancelable) e.preventDefault(); // no scroll/zoom while dragging a control
    }, { passive: false });
    const end = () => {
      if (start && start.moved) {
        groupSide = snapCtrlSide(lastX, window.innerWidth);
        suppressClickUntil = nowMs() + DRAG_CLICK_SUPPRESS_MS;
        applySide(magBtn); applySide(kbdBtn); applySide(pasteBtn);
        updateControlButtons();
        savePos();
        dbg('ctrl group moved side=' + groupSide + ' lift=' + Math.round(groupLift));
      }
      start = null;
    };
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
  }

  /** True while a just-finished drag should swallow the click it also produced. */
  function draggedRecently() { return nowMs() < suppressClickUntil; }

  function setMagnifyState() {
    if (!magBtn) return;
    magBtn.innerHTML = isZoomed() ? SVG_ZOOM_OUT : SVG_ZOOM_IN;
    magBtn.setAttribute('aria-label', isZoomed() ? 'Fit to screen' : 'Zoom in');
  }

  // Single owner of the floating-control visibility.
  function updateControlButtons() {
    const kb = getKeyboardActive();
    if (magBtn) {
      magBtn.style.display = (magEligible && !kb) ? 'flex' : 'none';
      magBtn.style.bottom = (CTRL_BASE_BOTTOM.mag + groupLift) + 'px';
    }
    if (kbdBtn) {
      kbdBtn.style.display = kb ? 'none' : 'flex';
      kbdBtn.style.bottom = (CTRL_BASE_BOTTOM.kbd + groupLift) + 'px';
    }
    if (pasteBtn) {
      pasteBtn.style.display = kb ? 'flex' : 'none';
      if (kb) {
        // Sit just above the keyboard's top edge (see keyboardInset).
        pasteBtn.style.bottom = ctrlPasteBottom(keyboardInset(hostGeometry(), window), groupLift) + 'px';
      } else {
        pasteBtn.style.bottom = (CTRL_BASE_BOTTOM.paste + groupLift) + 'px';
      }
    }
  }

  function makeMagnifyButton() {
    if (magBtn) return;
    loadPos(); // where the user last parked the group
    magBtn = document.createElement('div');
    magBtn.id = '__pcn_mag';
    magBtn.setAttribute('role', 'button');
    // Hidden by default — the magnify (fit/zoom) button is only meaningful on a
    // non-responsive page that we fit-to-width. Responsive pages reflow to mobile
    // and need no zoom; enterFit/exitFit show/hide it.
    magBtn.style.cssText = CTRL_BTN_CSS + 'bottom:70px;display:none;';
    magBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (draggedRecently()) return; toggleMagnify(); });
    (document.body || document.documentElement).appendChild(magBtn);
    setMagnifyState();

    // Manual keyboard toggle — for when auto-raise misses a field (cross-origin
    // frame, closed shadow root, a tap our hit-test didn't recognize). Stacked
    // below the magnify button. Must be tapped as a user gesture (iOS requirement
    // for raising the keyboard) — the click IS one.
    kbdBtn = document.createElement('div');
    kbdBtn.id = '__pcn_kbd';
    kbdBtn.setAttribute('role', 'button');
    kbdBtn.setAttribute('aria-label', 'Show keyboard');
    kbdBtn.innerHTML = SVG_KBD;
    kbdBtn.style.cssText = CTRL_BTN_CSS + 'bottom:16px;';
    kbdBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (draggedRecently()) return; manualKeyboardToggle(); });
    (document.body || document.documentElement).appendChild(kbdBtn);

    // Paste from the device clipboard into the focused remote field. readText()
    // inside this click is a user gesture, so iOS shows its NATIVE "Paste"
    // permission bubble — the closest thing to the system paste flow a web page
    // can offer (the invisible proxy has no visible text to long-press).
    if (navigator.clipboard && navigator.clipboard.readText) {
      pasteBtn = document.createElement('div');
      pasteBtn.id = '__pcn_paste';
      pasteBtn.setAttribute('role', 'button');
      pasteBtn.setAttribute('aria-label', 'Paste');
      pasteBtn.innerHTML = SVG_PASTE;
      // Hidden until the keyboard is up — pasting only makes sense with a
      // focused field, and the idle screen shouldn't carry extra chrome. (We
      // can't ALSO gate on "clipboard has content": iOS offers no silent
      // clipboard probe — any read pops the system permission pill.)
      pasteBtn.style.cssText = CTRL_BTN_CSS + 'bottom:124px;display:none;';
      pasteBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (draggedRecently()) return; pasteFromDevice(); });
      (document.body || document.documentElement).appendChild(pasteBtn);
    }
    // keyboardActive flips in a dozen places (raise, blur, watchdog, viewport
    // shrink...); a cheap poll owns the floating-control visibility so no single
    // flip site can miss one. The keyboard raise/dismiss and fit toggle also call
    // updateControlButtons() directly for immediacy (no open/close flicker).
    // Draggable as a group, and positioned from the restored side/lift.
    applySide(magBtn); applySide(kbdBtn); applySide(pasteBtn);
    makeDraggable(magBtn); makeDraggable(kbdBtn); makeDraggable(pasteBtn);
    updateControlButtons();
    setInterval(updateControlButtons, 300);
  }

  function pasteFromDevice() {
    if (!navigator.clipboard || !navigator.clipboard.readText) { dbg('paste: no clipboard API'); return; }
    const wasUp = getKeyboardActive();
    navigator.clipboard.readText().then((text) => {
      dbg('paste btn chars=' + (text ? text.length : 0));
      if (text) insertPastedText(text);
      // Tapping the button blurred the proxy; restore focus so the keyboard
      // stays up and typing continues where the paste landed.
      const proxy = getProxy();
      if (wasUp && proxy) {
        setAllowBlur(true);
        try { proxy.focus(); } catch (_) {}
        setKeyboardActive(true);
        setTimeout(() => { setAllowBlur(false); }, 120);
      }
    }).catch((err) => { dbg('paste denied: ' + (err && err.name)); });
  }

  // Use contains() so a tap whose target is the button's inner <svg>/<line> still
  // counts as a button tap (else the touch guards/click-swallow would eat it).
  function onMagButton(target) {
    return !!(target && ((magBtn && magBtn.contains(target)) || (kbdBtn && kbdBtn.contains(target)) ||
      (pasteBtn && pasteBtn.contains(target))));
  }

  function manualKeyboardToggle() {
    if (getKeyboardActive()) { dismissKeyboard(); return; }
    // Non-destructive raise. A synth-tap on a field is DESTRUCTIVE when that field
    // is a combobox/select (it opens the popup and blurs → editable=false), so we
    // only tap when NOTHING is focused (to give keys a home on cross-origin /
    // shadow-DOM fields our hit-test can't see). When the remote already has a
    // field focused, just raise onto it — to target a DIFFERENT field, tap that
    // field directly (the normal touch path focuses it and raises the keyboard).
    const remoteFocusKey = getRemoteFocusKey();
    if (remoteFocusKey) {
      dbg('manual: remote field ' + remoteFocusKey + ' focused -> raise only (no tap)');
    } else {
      focusClosestInput();
    }
    raiseKeyboard('button');
  }

  return {
    makeMagnifyButton, setMagnifyState, updateControlButtons, onMagButton,
    pasteFromDevice, manualKeyboardToggle,
    setMagEligible(v) { magEligible = v; },
  };
}
