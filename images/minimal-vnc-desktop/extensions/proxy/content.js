// Popcorn Proxy Extension - Content Script
// Bridges between page context and extension background

(function() {
  'use strict';

  // A global cursor rule, injected at document_start on every document:
  //
  // 1. cursor:none — this is a touch/kiosk stream; the pointer is a server-side
  //    software cursor baked into the VNC framebuffer, and unclutter only hides
  //    it while idle (it reappears over native <select>/date pickers). cursor:none
  //    on page content makes Chromium report a blank cursor to X, so none is drawn.
  //
  //
  // Re-applies on every navigation because the content script runs per document.
  try {
    const cs = document.createElement('style');
    cs.textContent = '*,*::before,*::after{cursor:none!important}';
    (document.head || document.documentElement).appendChild(cs);
  } catch (_) {}

  // injected.js runs as a MAIN-world content script (see manifest) so its
  // stealth patches install synchronously at document_start, before any page
  // script.

  // ---- JS dialog bridge (isolated world half) -------------------------------
  // injected.js overrides alert/confirm/prompt in the PAGE world so Chromium never
  // opens a dialog of its own — see dialog.go. The remaining advantage over the CDP
  // path is only the DUPLICATE dialog: CDP cannot suppress Chromium's own clipped
  // one, so the viewer has to cover the stream to hide it. The timing argument no
  // longer applies — the CDP path waits for the user's tap on an alert too.
  //
  // confirm()/prompt() must return SYNCHRONOUSLY, so the override blocks the page's
  // JS thread on a synchronous XHR performed HERE. It runs in the isolated world on
  // purpose: the token that authenticates this endpoint must not be readable by page
  // script, or the page could forge viewer chrome (a fake password sheet that looks
  // like it came from us). The two worlds talk through string attributes on a shared
  // DOM node — strings cross worlds safely, unlike object references.
  //
  // http://127.0.0.1 is exempt from mixed-content blocking, so this works from an
  // https page. Kept a SIMPLE request (text/plain) so no CORS preflight is added to
  // a call that is already blocking the main thread.
  // OFF until the browser-side half is proven. The SERVER half is verified
  // end-to-end (token issue -> viewer broadcast -> reply -> HTTP response), but the
  // synchronous XHR out of the page never reaches the proxy: it hangs instead of
  // failing, which wedges the renderer for the whole dialogWait window. Leading
  // suspects are the container's proxy config not bypassing 127.0.0.1 for plain
  // HTTP (only the WebSocket path is known-bypassed) and Chrome's Private Network
  // Access preflight, which needs Access-Control-Allow-Private-Network on a
  // public-page -> localhost request.
  //
  // With this false the listener is never registered, so injected.js's ask() finds
  // no answer and falls straight through to the native dialog — i.e. the shipped
  // behaviour is exactly the committed CDP path, unchanged.
  const DIALOG_BRIDGE_ENABLED = false;
  const DIALOG_URL = 'http://127.0.0.1:6080/dialog';
  let dialogToken = null;
  // Fetched AHEAD of any dialog, with retries: the answer path is synchronous, so
  // there is no chance to fetch on demand. The token exists only once the
  // background's publisher socket is up, which at document_start it usually isn't
  // (and an MV3 worker may be asleep). Retry until it lands, then stop. Until then
  // the override falls through to the native dialog — clipped, but the message is
  // never silently swallowed, which is the one outcome worse than clipping.
  (function fetchDialogToken(attempt) {
    if (!DIALOG_BRIDGE_ENABLED) return;
    if (dialogToken) return;
    if (attempt > 20) return; // ~1 minute of trying; a dialog before that uses native
    try {
      chrome.runtime.sendMessage({ type: 'PCN_DIALOG_TOKEN' }, (res) => {
        if (res && res.token) { dialogToken = res.token; return; }
        setTimeout(() => fetchDialogToken(attempt + 1), attempt < 5 ? 500 : 3000);
      });
    } catch (_) {
      setTimeout(() => fetchDialogToken(attempt + 1), 3000);
    }
  })(0);

  document.addEventListener('pcn-dialog-ask', (ev) => {
    if (!DIALOG_BRIDGE_ENABLED) return; // -> no data-pcn-res -> page uses native
    const node = ev.target;
    if (!node || !node.getAttribute) return;
    if (!dialogToken) return; // no answer attribute -> page falls back to native
    let req;
    try { req = JSON.parse(node.getAttribute('data-pcn-req') || 'null'); } catch (_) { return; }
    if (!req) return;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', DIALOG_URL, false); // SYNCHRONOUS: this is what blocks the page
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.send(JSON.stringify({
        token: dialogToken,
        type: req.type,
        message: req.message,
        defaultPrompt: req.defaultPrompt,
        url: location.href,
      }));
      if (xhr.status === 200) node.setAttribute('data-pcn-res', xhr.responseText);
    } catch (_) {
      // Endpoint unreachable / blocked: leave data-pcn-res unset so the page uses
      // the real dialog rather than losing the message entirely.
    }
  }, true);

  // Listen for messages from the injected script
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || !message.type || !message.type.startsWith('PCN_PROXY_')) return;
    if (message.direction !== 'to-extension') return;

    const requestId = message.requestId;

    try {
      const response = await chrome.runtime.sendMessage({
        type: message.type,
        config: message.config
      });

      window.postMessage({
        type: 'PCN_PROXY_RESPONSE',
        direction: 'to-page',
        requestId: requestId,
        success: response.success,
        result: response.result || response.config,
        error: response.error
      }, '*');
    } catch (error) {
      window.postMessage({
        type: 'PCN_PROXY_RESPONSE',
        direction: 'to-page',
        requestId: requestId,
        success: false,
        error: error.message
      }, '*');
    }
  });

  // --- Soft-keyboard focus detection ---------------------------------------
  // Report whether an editable element is focused so the mobile viewer can
  // auto-raise / dismiss the on-screen keyboard. This runs in EVERY frame
  // (manifest all_frames:true), so a text field inside a same-origin iframe is
  // covered too. The signal is forwarded to the background worker, which owns
  // the single WebSocket to the proxy's /kbd hub. Detection stays entirely off
  // the CDP path — no automation signal.

  // Input types that raise a text soft-keyboard. Excludes pickers (date/time/
  // color) and non-text controls (button/checkbox/...) which either show a
  // native picker or no keyboard at all — forcing a keyboard there is wrong.
  const KEYBOARD_INPUT_TYPES = new Set([
    'text', 'search', 'email', 'url', 'tel', 'password', 'number', ''
  ]);

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      if (el.disabled || el.readOnly) return false;
      if (!KEYBOARD_INPUT_TYPES.has((el.type || 'text').toLowerCase())) return false;
      // Exclude inputs that are actually dropdown/picker TRIGGERS, not text
      // fields: a custom <select>/combobox built on an <input>, or a field that
      // opens its own picker. These shouldn't raise a text keyboard.
      //   - inputmode="none": the page explicitly suppresses the soft keyboard.
      const im = (el.getAttribute && el.getAttribute('inputmode') || '').toLowerCase();
      if (im === 'none') return false;
      // aria-haspopup: only a NON-typeable popup means "picker trigger". The
      // common case on a text input is an AUTOCOMPLETE combobox — a suggestions
      // listbox (Google/DuckDuckGo/Amazon search, address autofill: role=combobox
      // aria-haspopup=listbox) — which you absolutely DO type into and MUST raise
      // the keyboard. So allow 'listbox' and the legacy 'true'; exclude only the
      // popup kinds that replace typing (a dialog/menu/date-grid/tree the field
      // merely opens). Excluding 'listbox' here was why search boxes never raised
      // the keyboard (DuckDuckGo's `input[name=q]` is role=combobox haspopup=listbox).
      const hp = (el.getAttribute && el.getAttribute('aria-haspopup') || '').toLowerCase();
      if (hp === 'dialog' || hp === 'menu' || hp === 'grid' || hp === 'tree') return false;
      return true;
    }
    return false;
  }

  // Accumulate this frame's offset within the top window so a field inside a
  // same-origin iframe reports a rect in top-window (remote screen) coords —
  // which the viewer maps to framebuffer pixels for the keyboard lift. A
  // cross-origin ancestor throws; we stop there and the rect stays frame-local
  // (lift may be slightly off for cross-origin iframe fields).
  // Accumulate this frame's offset toward the top window, and report whether we
  // actually REACHED the top (all ancestors same-origin) or stopped at a cross-
  // origin boundary. When we stop early the offset is frame-local and useless on its
  // own; ownOffset() then uses the absolute position our parent published, because
  // reporting frame-local coords is what misplaced the lift inside a checkout/OAuth
  // iframe.
  function frameOffset() {
    let x = 0, y = 0, win = window, reachedTop = true;
    try {
      while (win !== win.top) {
        if (!win.frameElement) { reachedTop = false; break; } // cross-origin parent
        const r = win.frameElement.getBoundingClientRect();
        x += r.left;
        y += r.top;
        win = win.parent;
      }
    } catch (_) { reachedTop = false; /* cross-origin ancestor */ }
    return { x, y, reachedTop };
  }

  // Whole pixels. getBoundingClientRect's sub-pixel floats serialise at ~18 chars each ("629.4931030273438"),
  // which is most of a focus message on a long form — and the viewer only hit-tests taps with them.
  const px = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

  // Shift a state's rect + rects[] by (dx,dy). Clones the array so a cached/shared
  // rects list is never mutated in place.
  function offsetState(state, dx, dy) {
    if (!dx && !dy) return state;
    if (state.rect) state.rect = px({ x: state.rect.x + dx, y: state.rect.y + dy, w: state.rect.w, h: state.rect.h });
    if (Array.isArray(state.rects)) state.rects = state.rects.map((r) => px({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }));
    if (Array.isArray(state.selects)) {
      state.selects = state.selects.map((s) => Object.assign({}, s, {
        r: px({ x: s.r.x + dx, y: s.r.y + dy, w: s.r.w, h: s.r.h }),
      }));
    }
    // Pickers carry a rect the viewer pins a transparent local input over, exactly
    // like selects — three frames deep, an unshifted one puts the DOB field's hit
    // target two iframe origins away from the pixels it belongs to.
    if (Array.isArray(state.pickers)) {
      state.pickers = state.pickers.map((p) => Object.assign({}, p, {
        r: px({ x: p.r.x + dx, y: p.r.y + dy, w: p.r.w, h: p.r.h }),
      }));
    }
    if (state.nc) state.nc = { x: Math.round(state.nc.x + dx), y: Math.round(state.nc.y + dy) };
    return state;
  }

  // All editable-element rectangles on this frame, in top-window coords. The
  // viewer hit-tests a tap against these SYNCHRONOUSLY, so it pops the keyboard
  // only when a tap actually lands on an input — no per-tap round-trip, so it
  // behaves the same at 50ms or 5s RTT. (Shadow-DOM inputs in closed roots and
  // cross-origin iframes are not enumerable here — the viewer falls back to its
  // optimistic path when it has no rects for an area.)
  const EDITABLE_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
  const MAX_RECTS = 60;

  function collectRects() {
    const out = [];
    let els;
    try { els = document.querySelectorAll(EDITABLE_SELECTOR); } catch (_) { return out; }
    for (const el of els) {
      if (!isEditable(el)) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { continue; }
      if (r.width <= 0 || r.height <= 0) continue;
      // Frame-LOCAL here; emit() adds this frame's offset to the top document, so
      // cross-origin-iframe fields land in the right place.
      out.push(px({ x: r.left, y: r.top, w: r.width, h: r.height }));
      if (out.length >= MAX_RECTS) break;
    }
    return out;
  }

  let cachedRects = [];
  let cachedSelects = [];
  let cachedPickers = [];
  const selectElements = new Map(); // stable key -> select in THIS isolated frame
  const pickerElements = new Map(); // stable key -> temporal input in THIS frame
  function refreshRects() {
    cachedRects = collectRects();
    cachedSelects = collectSelects();
    cachedPickers = collectPickers();
  }

  // The top window's CSS viewport size (best-effort). The viewer maps a rect
  // through cr.height / vh, which is correct regardless of the remote device
  // pixel ratio or framebuffer size — no DPR assumption needed.
  function topViewportSize() {
    try { return { w: window.top.innerWidth, h: window.top.innerHeight }; }
    catch (_) { return { w: window.innerWidth, h: window.innerHeight }; }
  }

  // Focus can live inside open shadow roots; walk into them so web-component
  // inputs are detected (closed roots are opaque and unavoidably missed).
  function deepActiveElement(root) {
    let el = (root || document).activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  // Stable per-element focus identity. The viewer keys its focus tracking off
  // this to tell "a NEW field was focused" from "the same field is still
  // focused" — which a rect-derived key can't do (the rect shifts on scroll).
  // A WeakMap hands each element a token on first sight that persists for the
  // element's lifetime; the per-frame prefix keeps same-origin iframes from
  // colliding on the same counter. (Math.random here runs in the page, not a
  // sandbox.) Resets naturally on navigation when this script re-injects.
  const FOCUS_KEY_FRAME = Math.random().toString(36).slice(2, 8);
  const focusKeyMap = new WeakMap();
  let focusKeySeq = 0;
  function focusKeyFor(el) {
    if (!el || el.nodeType !== 1) return null;
    let k = focusKeyMap.get(el);
    if (!k) { k = FOCUS_KEY_FRAME + ':' + (++focusKeySeq); focusKeyMap.set(el, k); }
    return k;
  }

  // Native select proxies in the LOCAL viewer need their descriptors BEFORE the
  // tap: iOS will only open a picker synchronously from a real local <select>
  // receiving that gesture. Publish a bounded set of ordinary single-selects with
  // stable keys, top-window geometry, labels, and option structure. The merged
  // publisher enforces a 24 KiB wire budget and atomically drops the descriptor
  // set if it cannot fit, so a normal country-sized list can use the platform
  // picker without risking loss of keyboard state. Truly huge lists still fall
  // back to the existing in-page searchable picker.
  // Budget the bytes the wire carries, not the number of controls: 250 options
  // with long labels is ~30 KiB and costs the hub the WHOLE state, while 300
  // short ones are ~8 KiB and are safe. One control's share is capped so a huge
  // list cannot starve the rest of the page.
  const SELECT_WIRE_BUDGET = 16 * 1024;
  const SELECT_WIRE_SHARE = 0.7;          // of the budget, for one control
  const MAX_NATIVE_SELECTS = 32;          // backstop only; the budget decides
  const MAX_SELECT_TEXT = 120;

  function wireCost(value) {
    try { return JSON.stringify(value).length; } catch (_) { return Infinity; }
  }

  // injected.js draws an in-page sheet for lists it keeps. That sheet is a modal
  // over the whole viewport, and the viewer's local controls are invisible
  // overlays pinned to element positions — a sheet row over one is untappable and
  // a tap there opens the wrong control. Advertise nothing while it is up.
  const PAGE_SELECT_SHEET_ID = '__pcn_select_sheet';
  function pageSheetOpen() {
    try { return !!document.getElementById(PAGE_SELECT_SHEET_ID); } catch (_) { return false; }
  }

  function plainSelect(el) {
    return !!(el && el.tagName === 'SELECT' && !el.multiple && !el.disabled && el.size <= 1);
  }

  function optionHidden(opt) {
    if (!opt) return true;
    if (opt.hidden) return true;
    const group = opt.parentElement;
    if (group && group.tagName === 'OPTGROUP' && group.hidden) return true;
    try { return opt.style && opt.style.display === 'none'; } catch (_) { return false; }
  }

  function collectSelects() {
    const out = [];
    if (pageSheetOpen()) { selectElements.clear(); return out; }
    const nextElements = new Map();
    let wireBudget = SELECT_WIRE_BUDGET;
    let els;
    try { els = document.querySelectorAll('select'); } catch (_) { return out; }
    for (const sel of els) {
      if (out.length >= MAX_NATIVE_SELECTS || wireBudget <= 0) break;
      if (!plainSelect(sel)) continue;
      let r;
      try { r = sel.getBoundingClientRect(); } catch (_) { continue; }
      if (r.width <= 0 || r.height <= 0) continue;
      const count = sel.options ? sel.options.length : 0;
      if (count < 1) continue;
      const options = [];
      let selectedIncluded = false;
      for (let i = 0; i < count; i++) {
        const opt = sel.options[i];
        if (optionHidden(opt)) continue;
        const group = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP'
          ? opt.parentElement
          : null;
        options.push({
          i,
          t: String(opt.textContent || opt.label || '').slice(0, MAX_SELECT_TEXT),
          d: !!(opt.disabled || (group && group.disabled)),
          g: group ? String(group.label || '').slice(0, MAX_SELECT_TEXT) : undefined,
          gd: group ? !!group.disabled : undefined,
        });
        if (i === sel.selectedIndex) selectedIncluded = true;
      }
      // A hidden selected option cannot be represented faithfully by the local
      // control. Fall back instead of opening a picker with the wrong checkmark.
      if (!options.length || !selectedIncluded) continue;
      const key = focusKeyFor(sel);
      const descriptor = {
        k: key,
        r: px({ x: r.left, y: r.top, w: r.width, h: r.height }),
        s: sel.selectedIndex,
        a: String((sel.getAttribute && sel.getAttribute('aria-label')) || labelText(sel) || '').slice(0, MAX_SELECT_TEXT),
        o: options,
      };
      // Skipping keeps going, so an enormous list falls back to the in-page sheet
      // (which has the search box it needs anyway) and its neighbours keep theirs.
      const cost = wireCost(descriptor);
      if (cost > SELECT_WIRE_BUDGET * SELECT_WIRE_SHARE || cost > wireBudget) continue;
      nextElements.set(key, sel);
      out.push(descriptor);
      wireBudget -= cost;
    }
    selectElements.clear();
    for (const [key, sel] of nextElements) selectElements.set(key, sel);
    return out;
  }

  // Temporal inputs have the same mobile problem as <select>: Chromium's remote
  // picker is not part of the useful framebuffer/touch surface. Publish a small
  // structural descriptor so the viewer can place a real LOCAL date input over
  // the streamed pixels and let iOS own the platform UI.
  const MAX_NATIVE_PICKERS = 8;
  const NATIVE_PICKER_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

  function nativePickerInput(el) {
    return !!(el && el.tagName === 'INPUT' && NATIVE_PICKER_TYPES.has(String(el.type || '').toLowerCase()) &&
      !el.disabled && !el.readOnly);
  }

  function collectPickers() {
    const out = [];
    if (pageSheetOpen()) { pickerElements.clear(); return out; }
    const nextElements = new Map();
    let els;
    try { els = document.querySelectorAll('input[type="date"],input[type="time"],input[type="datetime-local"],input[type="month"],input[type="week"]'); } catch (_) { return out; }
    for (const input of els) {
      if (out.length >= MAX_NATIVE_PICKERS) break;
      if (!nativePickerInput(input)) continue;
      let r;
      try { r = input.getBoundingClientRect(); } catch (_) { continue; }
      if (r.width <= 0 || r.height <= 0) continue;
      const key = focusKeyFor(input);
      nextElements.set(key, input);
      out.push({
        k: key,
        t: String(input.type || '').toLowerCase(),
        r: px({ x: r.left, y: r.top, w: r.width, h: r.height }),
        v: String(input.value || '').slice(0, 64),
        min: String(input.min || '').slice(0, 64),
        max: String(input.max || '').slice(0, 64),
        step: String(input.step || '').slice(0, 32),
        req: !!input.required,
        a: String((input.getAttribute && input.getAttribute('aria-label')) || labelText(input) || '').slice(0, MAX_SELECT_TEXT),
      });
    }
    pickerElements.clear();
    for (const [key, input] of nextElements) pickerElements.set(key, input);
    return out;
  }

  // A <select> change reflows the form and can reveal a text field right under
  // the tap that picked the option; the browser then focuses that field, which
  // would pop the soft keyboard unintentionally (e.g. picking "Checkerboard"
  // and landing on the revealed "Line Color" input). Record the time of any
  // <select> change so describe() can suppress the raise for a brief window.
  let lastSelectChangeAt = 0;
  document.addEventListener('change', (e) => {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (t && t.tagName === 'SELECT') lastSelectChangeAt = Date.now();
  }, true);

  // Widest content extent of this document — lets the viewer detect a
  // non-responsive (fixed-width) page that overflows the mobile viewport and
  // switch it to fit-to-width.
  function docScrollWidth() {
    const d = document.documentElement, b = document.body;
    return Math.max(d ? d.scrollWidth : 0, b ? b.scrollWidth : 0);
  }

  // sb — px left until the top document's scroll BOTTOM (0 = at the bottom, or
  // no vertical scroll at all). The viewer's keyboard-occlusion pan keys on
  // this: with the soft keyboard overlaying the viewer, the page's own scroll
  // range ends with the last screenful behind the keys, and the viewer extends
  // its LOCAL pan only once the remote genuinely can't scroll further — so
  // scrolling stays native-ordered (page first, local sliver last). Whole px,
  // like every other measurement, so the report dedup keeps coalescing. Reads
  // scrollHeight the same way docScrollWidth reads scrollWidth (same cost
  // class; layout is already forced by the rect reads on every report).
  function docScrollBottom() {
    const d = document.documentElement, b = document.body;
    // Which element actually scrolls this document: normally documentElement,
    // but a page styled html{overflow:hidden} body{overflow:auto;height:100%}
    // scrolls its BODY instead. There window.scrollY stays 0 no matter how far
    // down the user is, so a scrollY-only read reports a huge distance-to-bottom
    // forever — the viewer then never believes the page is at its end and every
    // drag-up forwards to a remote that cannot scroll, leaving the occluded
    // strip permanently unreachable on that whole page class. scrollingElement
    // names the real scroller (and is correct in quirks mode, where it is body);
    // fall back through both roots for a detached/odd document.
    const se = document.scrollingElement || d;
    const y = (se && se.scrollTop) || window.scrollY || (b ? b.scrollTop : 0) || 0;
    // Pair the extent with the same element, or a body-scroller's tall content
    // would be measured against documentElement's viewport-sized scrollHeight.
    const sh = Math.max(
      (se && se.scrollHeight) || 0,
      d ? d.scrollHeight : 0,
      b ? b.scrollHeight : 0,
    );
    const view = (se && se.clientHeight) || window.innerHeight;
    return Math.max(0, Math.round(sh - y - view));
  }

  // State for the nearest scrollable ancestor of the focused field. The top
  // document can be at its bottom while a login modal or list still scrolls.
  function focusedScrollContainer(el) {
    for (let node = el && el.parentElement; node && node !== document.body; node = node.parentElement) {
      try {
        if (node.scrollHeight <= node.clientHeight + 2) continue;
        const overflowY = getComputedStyle(node).overflowY;
        if (!/auto|scroll|overlay/.test(overflowY)) continue;
        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        return {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          b: Math.max(0, Math.round(node.scrollHeight - node.scrollTop - node.clientHeight)),
        };
      } catch (_) {}
    }
    return null;
  }

  // xf — rects of CROSS-ORIGIN iframes in the top document, in CSS px.
  //
  // A tap inside one of these needs a compatibility mouse click, because Chrome
  // synthesizes `click` from a CDP touch tap in the MAIN frame but not inside an
  // out-of-process iframe. Measured from inside reCAPTCHA's own frame: a tap
  // delivered pointerdown/touchstart/touchend (all isTrusted) and NO click, so the
  // checkbox sat there ignoring it; a mouse click at the identical point delivered
  // pointerdown/mousedown/click and it activated.
  //
  // The viewer needs the rects because the compat click cannot be sent
  // unconditionally: in the main frame the touch ALREADY produces a click, so an
  // extra one would double-fire — harmless on a checkbox, a double submit on a
  // button. Reporting where the out-of-process frames are lets the tap path add the
  // click only where it is missing.
  //
  // contentDocument throws (or is null) exactly when the frame is cross-origin,
  // which is the same condition that makes it out-of-process under site isolation.
  const XF_MAX = 12;
  const XF_SCAN_MAX = 120;
  // Do not cache this measurement. reCAPTCHA commonly inserts an iframe whose
  // first document is same-origin about:blank, then navigates it to Google. A
  // cached empty list makes that frame invisible to the viewer for the one
  // follow-up report, and there may be no later mutation to correct it. The
  // scan is tiny (at most XF_MAX usable frames) and runs only on our already
  // throttled layout reports.
  function crossOriginFrameRects() {
    const out = [];
    try {
      const frames = document.querySelectorAll('iframe');
      for (let i = 0; i < frames.length && i < XF_SCAN_MAX && out.length < XF_MAX; i++) {
        const f = frames[i];
        let cross = true;
        try { cross = !f.contentDocument; } catch (_) { cross = true; }
        if (!cross) continue;
        const r = f.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue; // not laid out / hidden
        out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
    } catch (_) {}
    return out;
  }

  // ol — how many px of content hang off the LEFT of the viewport.
  //
  // scrollWidth cannot see negative offsets, and that blind spot is the whole reason
  // this exists. A layout centred for a wider viewport (a fixed-width modal at
  // left:50%) pushes content to a negative `left`, which no amount of scrolling can
  // reach — you cannot scroll left of the origin. Measured on Pinterest's login at a
  // 360px viewport: scrollWidth reported 393 (under the viewer's 414 trigger, so it
  // read as "fits") while 99 elements sat at a negative left, 48px hung off it, and
  // the true extent was 579. The user's screenshot showed exactly that — the heading
  // and "Forgot password?" sliced off at the left edge — on a page the detector had
  // just called fine.
  //
  // DETECTOR ONLY. An earlier version also reported the full extent (cw) and the
  // viewer fitted to it; that failed, because the widest element in the DOCUMENT is
  // not the layout the user is looking at — on a login modal over the feed it
  // measured the masonry grid (1454 at a 393px viewport) and emulated a desktop page.
  // Here the viewer only asks "is anything unreachable?" and answers with a CONSTANT
  // width, so this number's magnitude is never trusted.
  //
  // getBoundingClientRect forces layout, so: capped at OVERFLOW_SCAN_MAX (a partial
  // answer on a huge DOM still beats none) and cached for OVERFLOW_TTL_MS, or the
  // 1.5s heartbeat plus focus events would turn it into per-event layout thrash. The
  // scan must be WHOLE-TREE: a first version walked `body > *, body > * > *` for
  // cheapness and reported ol=0 on this very page, because the negatively-positioned
  // elements are deep while their top-level ancestors sit at left:0.
  // Set by the MutationObserver at the bottom of this file: the cached overflow
  // measurement is stale because the DOM changed. Declared HERE, above
  // leftOverflowStats(), because the initial report() runs before that setup and a
  // `let` referenced before its declaration executes throws.
  let overflowDirty = false;
  const OVERFLOW_SCAN_MAX = 4000;
  const OVERFLOW_TTL_MS = 2000;
  let leftOverflowCache = -1, leftOverflowWidthCache = 0, leftOverflowAt = 0;
  // olw — the WIDTH of the widest clipped piece of real content.
  //
  // ol says how far content hangs off the left; olw says how wide the thing
  // hanging off actually is, and that second number is the one the viewer can act
  // on. ol cannot drive a fit width because it never converges: measured across a
  // width sweep of Pinterest's login, ol sat at 34px at EVERY width from 393 to
  // 600 — one 60px decorative element is permanently at -34 — so "widen until ol
  // is small" escalates to the cap and re-lays the page out as desktop. olw over
  // the same sweep went 392 -> 60 the moment the form fit, which is exactly the
  // signal needed: fit to ~olw and the clipping is gone in ONE step.
  //
  // "Real content" = form controls, buttons, links, and text-bearing LEAVES.
  // Containers are excluded deliberately. An earlier attempt (cw) reported the
  // widest element in the document and picked up Pinterest's masonry grid — 1454px
  // at a 393px viewport — so the viewer emulated a desktop page. A leaf cannot
  // misrepresent the layout that way, and widening does not make a text leaf wider,
  // which is what stops this from escalating the way scrollWidth did.
  const INTERACTIVE_SEL = 'input,button,select,textarea,a,label,summary';
  function meaningfulLeaf(el) {
    try {
      if (el.matches(INTERACTIVE_SEL)) return true;
      return el.children.length === 0 && (el.textContent || '').trim().length > 0;
    } catch (_) { return false; }
  }

  // Both numbers come from ONE pass: getBoundingClientRect forces layout, so a
  // second scan would double the cost of the most expensive thing this file does.
  function leftOverflowStats() {
    const now = Date.now();
    if (!overflowDirty && leftOverflowCache >= 0 && now - leftOverflowAt < OVERFLOW_TTL_MS) {
      return { ol: leftOverflowCache, olw: leftOverflowWidthCache };
    }
    overflowDirty = false;
    try {
      let minLeft = 0, widest = 0, n = 0;
      const els = document.querySelectorAll('body *');
      for (let i = 0; i < els.length && n < OVERFLOW_SCAN_MAX; i++) {
        const el = els[i];
        const r = el.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) continue; // not laid out
        n++;
        if (r.left < minLeft) minLeft = r.left;
        // Clipped-content candidate. Needs BOTH dimensions (a 0-height element is
        // not something the user can read) where ol above tolerates one.
        if (r.left < -1 && r.width > 0 && r.height > 0 && r.width > widest && meaningfulLeaf(el)) {
          widest = r.width;
        }
      }
      leftOverflowCache = Math.round(-Math.min(0, minLeft));
      leftOverflowWidthCache = Math.round(widest);
      leftOverflowAt = now;
      return { ol: leftOverflowCache, olw: leftOverflowWidthCache };
    } catch (_) { return { ol: 0, olw: 0 }; }
  }

  // Whether the page needs the legacy ~980px desktop layout viewport used by
  // mobile Safari for pages that do not declare mobile viewport behaviour.
  // Safari also infers a device-sized width from initial-scale when width is
  // omitted, so width=device-width is not the only usable declaration.
  function declaredLayoutViewportWidth() {
    try {
      const metas = document.getElementsByTagName('meta');
      for (let i = 0; i < metas.length; i++) {
        if ((metas[i].name || '').toLowerCase() === 'viewport') {
          const c = metas[i].getAttribute('content') || '';
          return globalThis.__POPCORN_VIEWPORT_META__.declaredLayoutWidth(c);
        }
      }
      return 980;
    } catch (_) { return null; }
  }

  // --- Sensitive-field detection --------------------------------------------
  // Sensitive = plausibly a secret: password, OTP/2FA, PIN, card, bank account, SSN, token, seed phrase.
  // type=password + a few autocomplete tokens missed both `<input type="tel" name="otp" maxlength="6">` and
  // card fields with autocomplete="off", so these rules read every public signal and lean over-inclusive.

  // Secret-naming words, matched against name/id/placeholder/aria-label/title/<label>.
  const SENSITIVE_WORDS = new RegExp([
    'passw', 'passcode', 'pass[\\s_-]*phrase', 'secret', '\\btoken\\b', 'api[\\s_-]*key', 'private[\\s_-]*key',
    'otp', 'one[\\s_-]*time', '\\btotp\\b', '\\b2fa\\b', '\\bmfa\\b', '\\bpin\\b',
    '(verification|confirmation|security|auth|authenticator|access|sms|login)[\\s_-]*code',
    '\\bcvv\\b', '\\bcvc\\b', '\\bcsc\\b', 'card[\\s_-]*(number|code|verification)', 'cardnum', '\\bccnum',
    'credit[\\s_-]*card', '\\bcc[\\s_-]*(num|number|exp|csc)', 'account[\\s_-]*number', 'routing[\\s_-]*number',
    'sort[\\s_-]*code', '\\biban\\b', '\\bssn\\b', 'social[\\s_-]*security', 'tax[\\s_-]*id',
    'seed[\\s_-]*phrase', 'mnemonic', 'recovery[\\s_-]*(code|phrase|key)',
  ].join('|'), 'i');

  // Short numeric fields that are NOT secrets. Exempts the shape rule only — an explicit secret word or
  // autocomplete token still wins, so "PIN code" (a postcode in India) stays exempt but "card PIN" does not.
  const BENIGN_SHORT = /zip|postal|post[\s_-]*code|pincode|pin[\s_-]*code|area[\s_-]*code|country[\s_-]*code|dial[\s_-]*code|\bage\b|quantity|\bqty\b|house|flat|floor|\broom\b|extension|\bext\b/i;

  // Only useful when the page bothers to set them; the word/shape rules carry the rest.
  const SENSITIVE_AUTOCOMPLETE = /one-time-code|password|cc-number|cc-csc|cc-exp|cc-name/;

  // Luhn — recognises a card number by SHAPE, for the card field with no honest name or autocomplete token.
  function looksLikeCardNumber(value) {
    const digits = String(value).replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(digits)) return false;
    let sum = 0, dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  // Often the ONLY honest signal — "Enter the 6-digit code" next to an <input name="c">.
  function labelText(el) {
    try {
      if (el.labels && el.labels.length) return (el.labels[0].textContent || '').slice(0, 200);
      const by = el.getAttribute && el.getAttribute('aria-labelledby');
      if (by) {
        const n = document.getElementById(by.split(/\s+/)[0]);
        if (n) return (n.textContent || '').slice(0, 200);
      }
    } catch (_) {}
    return '';
  }

  function isSensitiveField(el, type, ac, attr, value) {
    if (type === 'password' || SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
    const text = ['name', 'id', 'placeholder', 'aria-label', 'title', 'data-testid']
      .map((n) => attr(n).slice(0, 256)).concat(labelText(el)).join(' ');
    if (SENSITIVE_WORDS.test(text)) return true;

    // Shape rule for the field that names itself nothing: OTP/PIN/CVV are numeric and a few chars long
    // (maxlength=1 for the split six-box idiom). Only a postcode collides, and losing its echo is cheap.
    // Numeric = any of type/inputmode/pattern, since the legacy OTP idiom is pattern="[0-9]*" on type=text.
    const numeric = type === 'tel' || type === 'number' || /numeric|tel|decimal/i.test(attr('inputmode')) || /\[0-9\]|\\d/.test(attr('pattern'));
    let maxLen = -1;
    try { if (el.maxLength > 0) maxLen = el.maxLength; } catch (_) {}
    if (numeric && maxLen >= 1 && maxLen <= 8 && !BENIGN_SHORT.test(text) && !/postal-code/.test(ac)) return true;

    // Last resort: the value is itself a card number.
    return looksLikeCardNumber(value);
  }

  const IS_TOP = window === window.top;

  function describe(el) {
    const vp = topViewportSize();
    // rects/vw/vh ride on every message (even editable:false) so the viewer can
    // hit-test taps and dismiss reliably regardless of focus state.
    const base = { vw: vp.w, vh: vp.h, rects: cachedRects, selects: cachedSelects, pickers: cachedPickers };
    // These rects are viewport-relative: the viewer needs the offset they were
    // measured at to tell a settled page from one gliding under a fling.
    try { base.sy = Math.round(window.scrollY || 0); } catch (_) {}
    // A top-document sheet covers a child frame's box too, so one frame's sheet
    // has to suppress every frame's overlays.
    if (pageSheetOpen()) base.sheet = true;
    // sw (content width, for fit-to-width) and pid (per-document id, reset
    // fit-mode on navigation) only make sense from the TOP document — a per-frame
    // FOCUS_KEY_FRAME from a subframe would otherwise look like a navigation.
    if (IS_TOP) {
      const viewportWidth = declaredLayoutViewportWidth();
      base.sw = docScrollWidth(); base.pid = FOCUS_KEY_FRAME; base.novp = viewportWidth !== null;
      if (viewportWidth !== null) base.vpw = viewportWidth;
      // sb: distance to the scroll bottom — drives the viewer's keyboard-
      // occlusion pan (see docScrollBottom). 0 is the load-bearing value.
      base.sb = docScrollBottom();
      const sc = focusedScrollContainer(el);
      if (sc) base.sc = sc;
      // The viewer's short reload-on-resize guard must distinguish a document
      // reload caused by its own width change from a real cross-site navigation
      // (notably an OAuth return). Origin deliberately excludes paths/query data.
      try { base.origin = location.origin; } catch (_) {}
      // ol: px of content hanging off the LEFT — unreachable, and invisible to sw.
      // olw: how wide the widest clipped piece of real content is — the number the
      // viewer fits to, because ol alone never converges (see leftOverflowStats).
      const lo = leftOverflowStats();
      base.ol = lo.ol;
      base.olw = lo.olw;
      // xf: cross-origin iframe rects — where a tap needs a compat mouse click.
      base.xf = crossOriginFrameRects();
      // wf: whether this document's WINDOW holds focus. The background uses it to
      // pick which tab's state to publish. tab.active alone cannot do that job —
      // it means "active in its own window", so with two windows open two tabs are
      // both "active" and their heartbeats alternate in the published stream (the
      // cross-tab bleed bug). document.hasFocus() is browser-global: at most one
      // top document has it. Consumed by background.js, never forwarded.
      try { base.wf = document.hasFocus(); } catch (_) {}
    }
    // Just picked a <select> option → any editable that gets focused now is a
    // reveal-under-the-tap side effect, not an intentional focus. Report it as
    // non-editable so the keyboard stays down; a deliberate tap after the window
    // focuses and raises normally.
    if (Date.now() - lastSelectChangeAt < 600) return { editable: false, ...base };
    if (!isEditable(el)) return { editable: false, ...base };
    let rect = null;
    try {
      const r = el.getBoundingClientRect();
      // Frame-LOCAL; emit() adds this frame's offset to the top (see ownOffset).
      rect = px({ x: r.left, y: r.top, w: r.width, h: r.height });
    } catch (_) { /* detached node */ }
    const isInput = el.tagName === 'INPUT';
    const attr = (name) => (el.getAttribute && el.getAttribute(name)) || '';
    // Hints are page-controlled strings. Cap them: a huge placeholder would push the focus message past the
    // hub's frame limit, and since background.js resends the cached state on every reconnect, one oversized
    // state would loop (send -> socket torn down -> reconnect -> resend). No hint needs 256+ chars.
    const hint = (name) => attr(name).slice(0, 256);
    const type = isInput ? (el.type || 'text').toLowerCase() : 'text';
    const ac = attr('autocomplete').toLowerCase();
    // Nearest ancestor [lang]/[dir], falling back to the document — so the proxy
    // adopts the field's script direction (RTL for Arabic/Hebrew) and language
    // dictionary. Public attributes, so safe to publish even on sensitive fields.
    const nearest = (name) => {
      try { const a = el.closest && el.closest('[' + name + ']'); if (a) return a.getAttribute(name) || ''; } catch (_) {}
      return '';
    };
    const lang = (nearest('lang') || (document.documentElement && document.documentElement.lang) || '').slice(0, 64);
    const dir = (nearest('dir') || document.dir || '').slice(0, 64);
    let value = '';
    try { value = el.value != null ? el.value : (el.isContentEditable ? (el.textContent || '') : ''); } catch (_) {}
    // Never fingerprint secret fields — no length, no value, no hash leaves the page. The viewer disables
    // drift detection and local echo for these (sync.sensitive) rather than tracking them.
    const sensitive = isSensitiveField(el, type, ac, attr, value);
    return {
      editable: true,
      rect,
      ...base,
      // Stable identity so the viewer distinguishes a new field from the same
      // one still focused (see focusKeyFor). Survives scroll/resize/re-report.
      focusKey: focusKeyFor(el),
      // Hints let the viewer's proxy input adopt the right keyboard layout
      // (email/tel/number/decimal), SMS autofill, and Enter-key label.
      hints: {
        type: isInput ? (el.type || 'text') : 'text',
        tag: el.tagName,
        inputMode: hint('inputmode'),
        enterKeyHint: hint('enterkeyhint'),
        autoComplete: hint('autocomplete'),
        // name/placeholder are the only signals on a field like Kaggle's sign-in
        // (<input type="text" autocomplete="on" name="email">): type says nothing and
        // autocomplete="on" carries no information, so without these the viewer cannot
        // tell an address field from prose — and Gboard then auto-spaces a tapped
        // suggestion into an invalid email. Metadata only, exactly like type/pattern;
        // never the field's VALUE, which the sensitive-field rules still govern.
        name: hint('name'),
        placeholder: hint('placeholder'),
        // pattern lets the viewer show a numeric pad on the legacy pattern="[0-9]*"
        // OTP/PIN/zip idiom (no inputmode). lang/dir drive the proxy's script
        // direction + dictionary. maxLength is published for reference only — the
        // viewer must NOT set it on the live proxy (it would truncate the chew buffer).
        pattern: hint('pattern'),
        maxLength: (isInput && el.maxLength > 0) ? el.maxLength : undefined,
        lang,
        dir,
        // Shift/correction behaviour the proxy keyboard should mirror so a name
        // field word-caps, a sentence textarea auto-shifts, and a code field
        // stays literal — otherwise everything types lowercase (a native tell).
        autoCapitalize: hint('autocapitalize'),
        autoCorrect: hint('autocorrect'),
        spellCheck: hint('spellcheck'),
      },
      // Drift-detection fingerprint (never for secret fields) PLUS the full field
      // text so the viewer can SEED its hidden proxy input with real content. An
      // empty proxy gives the OS IME no word context, which is exactly why iOS
      // autocorrect/suggestion picks are eventless and unrecoverable (empty field =
      // nothing to correct or replace); handing the real text back gives every
      // keyboard genuine context. Capped so a huge textarea can't bloat the focus
      // message; secret fields still send neither length nor value.
      // val is stripped by background.js unless a viewer explicitly asked for
      // mirroring, so the default wire state carries only the two DERIVED facts the
      // keyboard logic needs: the length (drift detection) and whether the text ends
      // in a space (the trailing-space repair). Both are computed here because only
      // this frame can see the field.
      sync: {
        sensitive,
        len: sensitive ? undefined : value.length,
        tail: sensitive ? undefined : / $/.test(value),
        val: sensitive ? undefined : (value.length > 2048 ? value.slice(0, 2048) : value),
      },
    };
  }

  // --- Cross-frame positioning: offsets DOWN, state UP ----------------------
  // background.js aggregates one state PER frame and needs correct top-window
  // coords. frameOffset() can't cross a cross-origin boundary, so a field inside a
  // cross-origin iframe (Stripe/checkout/OAuth) would report frame-local coords and
  // the viewer's keyboard-lift lands in the wrong place.
  //
  // An earlier version fixed that by BUBBLING each frame's state up through
  // postMessage, with the parent folding a child's state into its own. That made the
  // parent trust data from a window it cannot authenticate: matching event.source to
  // one of its <iframe>s proves only that the sender is a child browsing context,
  // NOT that the message came from our content script. Any cross-origin child PAGE
  // could post the marker with arbitrary editable/hints/sensitive/sync values (page
  // script and our isolated world share one Window, so event.source is identical)
  // and the parent would relay it upward as trusted state.
  //
  // So the direction is inverted. STATE never crosses a frame boundary: every frame
  // reports its own state straight to the background over chrome.runtime, which only
  // content scripts can speak. What crosses is POSITION, and only downward — a
  // parent tells each child where that child's viewport sits in top coords, which is
  // information the parent already owns (it lays the iframe out). A child asks for
  // it on load, so there is no race against the parent's script starting first.
  //
  // Worst case for a forged position message is a mispositioned keyboard lift inside
  // a frame whose parent could move it anyway; a forged FIELD is no longer possible.
  let absOffset = null;   // our viewport origin in TOP coords, published by our parent
  let absAsks = 0;
  const ABS_MAX_ASKS = 10;
  // Retry ladder for "parent, where am I?". The old shape was 300/300/300 then a
  // flat 2000, which put a ~2s cliff right where a three-level embed lands: the
  // portal's form frame asks before its own parent has been positioned, that ask
  // is answered with silence, and the next attempt is 2s later. Until it lands
  // the frame cannot report ANY coordinate, so the first tap on the first field
  // waits that whole time for the remote's editable:true instead of raising the
  // keyboard from a local rect hit. Ramp instead of stepping: the same total
  // coverage (~7s) with no single gap wide enough to be felt.
  const ABS_ASK_DELAYS = [120, 200, 320, 500, 800, 1200, 2000];
  const publishedAbs = new WeakMap(); // iframe element -> last published "x,y"

  // Our offset to the top document, or null when we are inside a cross-origin
  // ancestor and have not been positioned yet. Same-origin chains never wait: the
  // walk in frameOffset() reaches the top on its own.
  function ownOffset() {
    const off = frameOffset();
    if (off.reachedTop) return { x: off.x, y: off.y };
    if (absOffset) return { x: absOffset.x, y: absOffset.y };
    return null;
  }

  // Ask our parent to position us. Unauthenticated on purpose: the only thing it can
  // trigger is the parent publishing geometry it already controls.
  function askForOffset() {
    if (window === window.top || absOffset || absAsks >= ABS_MAX_ASKS) return;
    if (frameOffset().reachedTop) return; // same-origin chain positions itself
    absAsks++;
    try { window.parent.postMessage({ __pcnKbdAbsReq: 1 }, '*'); } catch (_) {}
    emitBlind(); // keep the "my fields are invisible to you" notice fresh while we wait
    // Retry: at document_start the parent's content script may not be listening
    // yet, and a parent that is not positioned ITSELF answers nothing at all.
    setTimeout(askForOffset, ABS_ASK_DELAYS[Math.min(absAsks - 1, ABS_ASK_DELAYS.length - 1)]);
  }

  // Tell every child frame where it sits. Positions change on scroll/resize/layout,
  // so this runs on each report; unchanged positions are skipped (an ad-heavy page
  // has dozens of frames), and `force` re-publishes for a frame that just loaded.
  function publishChildOffsets(force, only) {
    const off = ownOffset();
    if (!off) return; // we don't know where we are, so we can't place anyone else
    let els;
    try { els = document.querySelectorAll('iframe, frame'); } catch (_) { return; }
    for (const f of els) {
      let cw;
      try { cw = f.contentWindow; } catch (_) { continue; }
      if (!cw || (only && cw !== only)) continue;
      let r;
      try { r = f.getBoundingClientRect(); } catch (_) { continue; }
      const x = Math.round(off.x + r.left), y = Math.round(off.y + r.top);
      const key = x + ',' + y;
      if (!force && publishedAbs.get(f) === key) continue;
      publishedAbs.set(f, key);
      try { cw.postMessage({ __pcnKbdAbs: 1, x, y }, '*'); } catch (_) {}
    }
  }

  // Coordinate-free "my fields are invisible to you" notice, sent once while this
  // frame is still waiting to be positioned.
  //
  // Silence was the old behaviour, and it hides the one fact the viewer needs: some
  // frame on this page HAS editable fields whose rects are missing from the merged
  // list. Without it a tap over a cross-origin form is indistinguishable from a tap
  // on a page of buttons — both look like 'unknown' coverage — so the viewer
  // refuses to raise the keyboard optimistically and the first tap waits a full
  // tunnel round-trip for the remote's editable:true (measured ~2s on mobile).
  //
  // Carries NO geometry and NO content: no rect, no rects, no hints, no value. Just
  // the blind flag, which is exactly the amount of information needed to say "do
  // not read a miss here as off-field". Cleared implicitly — the next real emit()
  // replaces this frame's slot in the background's per-frame map.
  //
  // RE-ASSERTED on a slow heartbeat rather than sent once: the background expires a
  // frame that has gone quiet (FRAME_STALE_MS, 6s), and a frame that is still
  // unpositioned past that point is exactly the one whose fields are still missing,
  // so letting the notice age out would silently restore the old behaviour at the
  // worst moment.
  // The heartbeat rides the ask ladder (askForOffset), which is already running for
  // exactly as long as this frame is unpositioned — no extra timer, and no layout
  // read per beat, because whether we hold fields is remembered rather than
  // recomputed. Once the ladder gives up we stop asserting too: a frame that can
  // never be positioned would otherwise leave every unknown tap on the page
  // raising the keyboard forever.
  const BLIND_REASSERT_MS = 2000;
  let blindSentAt = 0;
  let sawFields = false;
  function noteFields(state) {
    if (state.editable === true || (Array.isArray(state.rects) && state.rects.length > 0)) sawFields = true;
  }
  function emitBlind() {
    if (!sawFields) return;
    if (blindSentAt && Date.now() - blindSentAt < BLIND_REASSERT_MS) return;
    blindSentAt = Date.now();
    try { chrome.runtime.sendMessage({ type: 'PCN_KBD', state: { editable: false, rects: [], blind: 1 } }); } catch (_) {}
  }

  // Report our own state, in top coords, directly to the background.
  function emit(state) {
    const off = ownOffset();
    if (!off) {
      // Not positioned yet. Reporting frame-local coords would put every rect in the
      // wrong place, so keep asking — but say that our coverage is missing rather
      // than going completely dark (see emitBlind).
      noteFields(state);
      askForOffset();
      emitBlind();
      return;
    }
    offsetState(state, off.x, off.y);
    try { chrome.runtime.sendMessage({ type: 'PCN_KBD', state }); } catch (_) {
      // Worker spinning up / context gone; the next report resends absolute state.
    }
  }

  let lastKey = null;
  // force=true bypasses the dedup: the background worker expires frames that go
  // silent, so a live frame must be able to re-assert itself unchanged.
  function report(el, force) {
    refreshRects(); // keep the hit-test rects current on every emit
    const state = describe(el);
    if (pendingNoClick) { state.nc = pendingNoClick; pendingNoClick = null; force = true; }
    publishChildOffsets(force); // our children move with us
    const key = JSON.stringify(state);
    if (!force && key === lastKey) return; // focus/rect/hints/rects unchanged
    lastKey = key;
    emit(state);
  }

  // A choice originates in a real <select> in the LOCAL viewer. The background
  // routes only to the active tab/frame that most recently published this key;
  // revalidate everything again here because the page may have replaced the
  // element or disabled an option while the native picker was open.
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message) return false;
      if (message.type === 'PCN_PICKER_CHOICE') {
        const key = message.key;
        const value = message.value;
        const input = typeof key === 'string' ? pickerElements.get(key) : null;
        if (!input || !input.isConnected || !nativePickerInput(input) ||
            typeof value !== 'string' || value.length > 64) {
          if (sendResponse) sendResponse({ ok: false });
          return false;
        }
        const previous = input.value;
        input.value = value;
        let valid = input.value === value;
        try { valid = valid && input.checkValidity(); } catch (_) {}
        if (!valid) {
          input.value = previous;
          if (sendResponse) sendResponse({ ok: false });
          return false;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        report(deepActiveElement(), true);
        if (sendResponse) sendResponse({ ok: true });
        return false;
      }
      if (message.type !== 'PCN_SELECT_CHOICE') return false;
      const key = message.key;
      const index = message.index;
      const sel = typeof key === 'string' ? selectElements.get(key) : null;
      if (!sel || !sel.isConnected || !plainSelect(sel) || !Number.isInteger(index) || index < 0 || index >= sel.options.length) {
        if (sendResponse) sendResponse({ ok: false });
        return false;
      }
      const opt = sel.options[index];
      const group = opt && opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null;
      if (!opt || optionHidden(opt) || opt.disabled || (group && group.disabled)) {
        if (sendResponse) sendResponse({ ok: false });
        return false;
      }
      sel.selectedIndex = index;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      report(deepActiveElement(), true);
      if (sendResponse) sendResponse({ ok: true });
      return false;
    });
  } catch (_) {}

  window.addEventListener('message', (e) => {
    const m = e && e.data;
    if (!m) return;
    // A child asking to be positioned. Answer only for a window that really is one
    // of our child frames — this carries no privilege, but there is no reason to
    // reply to an unrelated window.
    if (m.__pcnKbdAbsReq === 1 && e.source) {
      publishChildOffsets(true, e.source);
      return;
    }
    if (m.__pcnKbdAbs !== 1) return;
    // ONLY our own parent may position us, and only with finite numbers.
    if (e.source !== window.parent) return;
    if (typeof m.x !== 'number' || typeof m.y !== 'number' || !isFinite(m.x) || !isFinite(m.y)) return;
    const moved = !absOffset || absOffset.x !== m.x || absOffset.y !== m.y;
    absOffset = { x: m.x, y: m.y };
    if (!moved) return;
    publishChildOffsets(true);            // pass the correction down the chain
    report(deepActiveElement(), true);    // and re-report our own rects at the new origin
  }, false);

  // Chromium selects a filled field's ENTIRE text on a synthetic-touch tap (which
  // is how the mobile viewer taps), whereas a real phone places a caret. That
  // makes re-tapping a field you already typed in select-everything, so the next
  // keystroke replaces it. Collapse that initial select-all to a caret at the end
  // so a re-tap edits/appends — native-mobile behavior. Only the tap-induced
  // select-all is collapsed (a brief poll right after focus); a deliberate
  // long-press select-all happens later and is left alone.
  function collapseTapSelectAll(el) {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
    let tries = 0;
    const tick = () => {
      if (document.activeElement !== el) return;
      let v;
      try { v = el.value; } catch (_) { return; }
      try {
        if (v && el.selectionStart === 0 && el.selectionEnd === v.length) {
          el.setSelectionRange(v.length, v.length);
          return;
        }
      } catch (_) { return; } // selectionStart unsupported (email/number) — skip
      if (++tries < 6) setTimeout(tick, 25); // the select-all lands async; poll ~150ms
    };
    setTimeout(tick, 0);
  }

  // focusin bubbles, so a single capturing listener sees every editable focus.
  // composedPath()[0] is the real target even across open shadow boundaries
  // (plain e.target is retargeted to the shadow host).
  document.addEventListener('focusin', (e) => {
    const path = e.composedPath && e.composedPath();
    const el = (path && path[0]) || e.target;
    report(el);
    collapseTapSelectAll(el);
  }, true);

  // On blur, focus may move synchronously to another editable (field-to-field
  // tabbing) — defer one tick and read the settled (deep) activeElement so we
  // don't emit a spurious "false" between two inputs.
  document.addEventListener('focusout', () => {
    setTimeout(() => report(deepActiveElement()), 0);
  }, true);

  // Top document navigating away / being frozen: emit a clean non-editable state
  // so the hub doesn't cache a stale editable:true (a field from the OLD page)
  // across the nav. Without this, an already-connected viewer's keyboard can stay
  // wedged up on a field that no longer exists after the remote page changes.
  if (IS_TOP) {
    window.addEventListener('pagehide', () => {
      try { emit({ editable: false, rects: [], selects: [], pickers: [] }); } catch (_) {}
    });
  }

  // Re-report on value changes so the viewer can detect input drift. Debounced
  // to avoid a message per keystroke; report() dedupes when the length is
  // unchanged, so this is quiet unless the field actually grew/shrank.
  let syncTimer = null;
  document.addEventListener('input', () => {
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      // Only push length updates for an editable field. Never emit "false" from
      // here (that would spuriously dismiss) — focusout owns the false signal.
      const el = deepActiveElement();
      if (isEditable(el)) report(el);
    }, 350);
  }, true);

  // ---- taps that produce no click ----------------------------------------
  // A tap forwarded as CDP touch does not always yield the compatibility mouse
  // events, and a control whose activation lives in a `click` handler is then dead:
  // measured on an iCheck-styled checkbox, which received pointerdown/touchstart/
  // pointerup/touchend and no click, so it never toggled — while the same pixel took
  // a real click fine. Chrome DOES synthesize the click for ordinary buttons, so we
  // cannot simply send one for every tap (that double-fires, and a double submit is
  // worse than a dead checkbox). Report the ones where the click genuinely never
  // arrived, and let the viewer replay it (see nc in the viewer's applySignal).
  const NOCLICK_GRACE_MS = 250;
  const NOCLICK_SELECTOR = 'a, button, input, label, select, summary, [role=button], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem]';
  let tapPending = null;    // { x, y, at, timer }
  let clickSeenAt = 0;
  let pendingNoClick = null;

  // Only replay for something that looks activatable: a page that handles the touch
  // itself (carousel, slider, map) suppresses the click deliberately, and replaying it
  // there would act twice.
  function looksClickable(x, y) {
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch (_) { return false; }
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      try {
        if (el.matches && el.matches(NOCLICK_SELECTOR)) return true;
        if (getComputedStyle(el).cursor === 'pointer') return true;
      } catch (_) { /* detached mid-walk */ }
    }
    return false;
  }

  document.addEventListener('click', () => { clickSeenAt = Date.now(); }, true);
  document.addEventListener('touchstart', (e) => {
    const t = e.changedTouches && e.changedTouches[0];
    if (!t || (e.touches && e.touches.length > 1)) { tapPending = null; return; }
    tapPending = { x: t.clientX, y: t.clientY, at: Date.now() };
  }, true);
  document.addEventListener('touchend', (e) => {
    const start = tapPending;
    tapPending = null;
    const t = e.changedTouches && e.changedTouches[0];
    if (!start || !t) return;
    // A drag/scroll is not a tap, and its click was never coming.
    if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) return;
    const x = t.clientX, y = t.clientY;
    const endedAt = Date.now();
    if (!looksClickable(x, y)) return;
    const ev = e;   // read defaultPrevented later: this listener captures, so the
                    // page's own handlers have not run yet
    setTimeout(() => {
      if (clickSeenAt >= endedAt) return;   // the browser produced one after all
      // preventDefault on the touch is the page saying it handled this itself; the
      // click is missing on purpose, and a real browser would not send one either.
      if (ev.defaultPrevented) return;
      pendingNoClick = { x, y };
      report(deepActiveElement(), true);    // carry it out on the next emit
    }, NOCLICK_GRACE_MS);
  }, true);

  // Rects shift on scroll / resize / layout; re-report (throttled) so the
  // viewer's tap hit-test stays accurate. A slow periodic refresh also catches
  // dynamically added forms (SPA route changes, lazy-rendered fields).
  let rectsTimer = null;
  function scheduleReport() {
    if (rectsTimer !== null) return;
    rectsTimer = setTimeout(() => { rectsTimer = null; report(deepActiveElement()); }, 250);
  }
  window.addEventListener('scroll', scheduleReport, true);
  window.addEventListener('resize', scheduleReport, true);
  // reCAPTCHA's anchor is an external iframe that often starts as about:blank.
  // Its cross-origin transition changes no parent-DOM nodes, so the mutation
  // observer below cannot see it. Capture its load and publish fresh geometry;
  // this is what arms the viewer's trusted VNC click for the checkbox.
  document.addEventListener('load', (e) => {
    const target = e.target;
    if (target && target.tagName === 'IFRAME') scheduleReport();
  }, true);

  // --- report promptly when the layout changes -----------------------------
  // The cadence used to be a 1500ms heartbeat plus a 2000ms measurement cache, so a
  // page that rendered its content late was reported up to ~1s after the fact.
  // Measured on Pinterest at a 360px viewport: the clipped login form existed in the
  // DOM at 3.33s and the viewer only heard about it at 4.32s — and it spent that
  // second showing the clipped layout before jumping to the fit. With this observer
  // the same measurement arrives at 3.30s, so the fit happens as the content appears
  // and there is no wrong-layout window to see.
  //
  // Cheap by construction: the handler only sets a flag and pokes scheduleReport,
  // which is already throttled to 250ms. getBoundingClientRect (which forces layout)
  // still runs at most once per report, not once per mutation — an observer on a page
  // like Pinterest fires hundreds of times a second.
  try {
    const mo = new MutationObserver(() => {
      overflowDirty = true; // cached rects are stale by definition now
      scheduleReport();
    });
    // The reCAPTCHA anchor can already exist when its image challenge is made
    // visible. That transition is frequently a class/style/src update on an
    // existing iframe or its wrapper, not a child-list mutation. Watching the
    // geometry-affecting attributes makes the challenge frame reach the viewer
    // before its first tile tap, where it takes the trusted VNC-click path.
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'src', 'width', 'height',
        'type', 'value', 'min', 'max', 'step', 'required', 'disabled', 'readonly'],
    });
  } catch (_) {}

  // A static legacy page may not mutate after its initial parse and may never
  // focus an editable control. Without an explicit ready report, its viewport
  // metadata reaches the viewer only on a later heartbeat, leaving a no-viewport
  // page cropped until the desktop-fit detector eventually runs. Report as soon
  // as the document's head/body are complete, then once more after resources load
  // in case the site adds its viewport tag or fixed-width shell late.
  // A frame inside a cross-origin ancestor cannot report anything until its parent
  // has positioned it, so ask immediately rather than waiting for the parent's next
  // layout change (an iframe that loads into a static page would wait forever).
  if (!IS_TOP) askForOffset();

  // Runs in EVERY frame, not just the top one. A cross-origin form frame (the
  // portal's hosted signup form) often renders its fields once, before our
  // MutationObserver is watching or with no further mutation at all, and never
  // focuses anything by itself — so its rects used to reach the viewer only when
  // the user focused a field, which is the very tap that needed them. The tap then
  // hit-tested against no coverage and could not raise the keyboard locally.
  // A forced report is also what re-sends a state that emit() had to drop while the
  // frame was unpositioned.
  const reportInitialLayout = () => report(deepActiveElement(), true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportInitialLayout, { once: true });
  } else {
    reportInitialLayout();
  }
  window.addEventListener('load', reportInitialLayout, { once: true });
  // Back/forward-cache restore is a fresh page to the user and to the remote, but
  // fires neither of the two above.
  window.addEventListener('pageshow', (e) => { if (e && e.persisted) reportInitialLayout(); });

})();
