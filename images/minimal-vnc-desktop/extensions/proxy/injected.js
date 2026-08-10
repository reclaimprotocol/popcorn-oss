// Popcorn Proxy Extension - Injected Script
// Exposes stealth API for page-level proxy configuration

(function() {
  'use strict';

  // ---- Passkey suppression on Google sign-in (SCOPED) ----------------------
  // Accounts that have a passkey make Google auto-launch a modal passkey
  // ceremony ("Complete sign-in using your passkey"), which fails in this
  // container (no authenticator / cross-device) with a "your device can't be
  // used" modal and blocks password login. Report no platform authenticator /
  // no conditional mediation and fail any WebAuthn get() fast the way a
  // user-cancel does, so Google drops straight to the password field.
  //
  // Deliberately SCOPED to Google's auth domain: every other page — including a
  // fingerprinting probe — keeps a pristine, untampered navigator.credentials,
  // so this adds ZERO detection surface where stealth actually matters. Toggle
  // with window.__PCN_KEEP_PASSKEY = true before this runs to disable.
  (function suppressGooglePasskey() {
    try {
      if (window.__PCN_KEEP_PASSKEY) return;
      var h = location.hostname || '';
      if (!/(^|\.)google\.com$/.test(h)) return;
      if (!('PublicKeyCredential' in window) || !navigator.credentials) return;
      try { PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function () { return Promise.resolve(false); }; } catch (_) {}
      try { PublicKeyCredential.isConditionalMediationAvailable = function () { return Promise.resolve(false); }; } catch (_) {}
      try { if (PublicKeyCredential.getClientCapabilities) PublicKeyCredential.getClientCapabilities = function () { return Promise.resolve({}); }; } catch (_) {}
      var origGet = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = function (options) {
        if (options && (options.publicKey || options.mediation === 'conditional')) {
          // Google catches NotAllowedError and falls back to the password field.
          return Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
        }
        return origGet(options);
      };
    } catch (_) {}
  })();

  const pendingRequests = new Map();
  let requestCounter = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || message.type !== 'PCN_PROXY_RESPONSE') return;
    if (message.direction !== 'to-page') return;

    const pending = pendingRequests.get(message.requestId);
    if (pending) {
      pendingRequests.delete(message.requestId);
      if (message.success) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || 'Unknown error'));
      }
    }
  });

  function sendToExtension(type, config) {
    return new Promise((resolve, reject) => {
      const requestId = ++requestCounter;
      pendingRequests.set(requestId, { resolve, reject });

      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 10000);

      window.postMessage({
        type: type,
        direction: 'to-extension',
        requestId: requestId,
        config: config
      }, '*');
    });
  }

  // Use non-obvious property name to avoid detection
  // Looks like an internal performance/config variable
  Object.defineProperty(window, '__pcn', {
    value: Object.freeze({
      set: function(config) {
        return sendToExtension('PCN_PROXY_SET', config);
      },
      clear: function() {
        return sendToExtension('PCN_PROXY_CLEAR', null);
      },
      get: function() {
        return sendToExtension('PCN_PROXY_GET', null);
      },
      ready: true
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });

  // --- Fullscreen shim -------------------------------------------------------
  // Native requestFullscreen fills the emulated SCREEN (1920x1080 per the CDP
  // device-metrics override), but the magnify view only shows the ~390px layout
  // viewport — so native fullscreen renders cropped, with Chromium's "press Esc
  // to exit" bubble half off-screen. Redefine the Fullscreen API to fill the
  // LAYOUT VIEWPORT via CSS (what the user actually sees). Works in desktop too
  // (fills the window). No native fullscreen → no crop, no Esc prompt. Sites
  // that read document.fullscreenElement / listen for fullscreenchange keep
  // working (video players, games, testufo, etc.).
  (function () {
    let fsEl = null;
    const STYLE_ID = '__pcn_fs_style';
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = '.__pcn_fs{position:fixed!important;inset:0!important;' +
        'width:100vw!important;height:100vh!important;max-width:100vw!important;' +
        'max-height:100vh!important;margin:0!important;z-index:2147483646!important;' +
        'background:#000!important}';
      (document.head || document.documentElement).appendChild(s);
    }
    function fire() {
      document.dispatchEvent(new Event('fullscreenchange'));
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    }
    function enter(el) { ensureStyle(); fsEl = el; el.classList.add('__pcn_fs'); fire(); return Promise.resolve(); }
    function exit() { if (fsEl) { fsEl.classList.remove('__pcn_fs'); fsEl = null; fire(); } return Promise.resolve(); }
    try {
      const ep = Element.prototype;
      ep.requestFullscreen = function () { return enter(this); };
      ep.webkitRequestFullscreen = function () { return enter(this); };
      ep.webkitRequestFullScreen = function () { return enter(this); };
      document.exitFullscreen = exit;
      document.webkitExitFullscreen = exit;
      const getter = { get: function () { return fsEl; }, configurable: true };
      Object.defineProperty(document, 'fullscreenElement', getter);
      Object.defineProperty(document, 'webkitFullscreenElement', getter);
    } catch (_) {}
  })();

  // --- Mobile navigation: keep content in one emulated tab -------------------
  // A new browser tab/window opens blank then navigates, so the server-side
  // emulator can't distinguish a content link (target=_blank / featureless
  // window.open) from an OAuth popup — and content tabs end up desktop-width.
  // Phones don't spawn tabs anyway, so open content links IN PLACE (they stay
  // inside the emulated viewport, and the emulator re-applies on navigation).
  // Only window.open() called WITH size features (OAuth "Continue with X",
  // payment windows) gets a real separate window — that's fullscreened + left
  // native server-side so its flow keeps working.
  (function () {
    try {
      const nativeOpen = window.open.bind(window);
      window.open = function (url, name, features) {
        if (features && /\b(width|height|popup)\b/i.test(String(features))) {
          return nativeOpen(url, name, features); // real popup (OAuth/payment)
        }
        if (url) { try { location.assign(url); } catch (_) { location.href = url; } }
        return window;
      };
      // <a target="_blank"> content links → same tab.
      document.addEventListener('click', function (e) {
        const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
        if (a) a.target = '_self';
      }, true);
    } catch (_) {}
  })();

  // --- In-page <select> picker ----------------------------------------------
  // Native <select> dropdowns are GTK OS widgets, not DOM — so under the CDP
  // magnify pipeline a tap falls THROUGH the popup to the element behind it, and
  // the OS cursor shows over the list. Replace the native dropdown with a DOM
  // bottom-sheet (the shape mobile browsers use natively): we suppress the OS
  // popup, render the <option>s as a tappable list, then write the value back
  // and fire input/change so the page reacts exactly as it would natively.
  // Scales to huge lists (country/year selects with 1000+ options): rows are
  // built once in a fragment, a single delegated click handler serves them all
  // (no per-row listeners), and a filter box appears past a threshold so the
  // user types to narrow instead of scrolling thousands of rows.
  (function () {
    const SHEET_ID = '__pcn_select_sheet';
    const FILTER_THRESHOLD = 15; // show the search box past this many options
    let open = false;

    function ensureStyle() {
      if (document.getElementById(SHEET_ID + '_style')) return;
      const s = document.createElement('style');
      s.id = SHEET_ID + '_style';
      s.textContent =
        '#' + SHEET_ID + '{position:fixed!important;inset:0!important;z-index:2147483647!important;' +
          'display:flex!important;align-items:flex-end!important;justify-content:center!important;' +
          'background:rgba(0,0,0,.4)!important;font-family:system-ui,-apple-system,"Segoe UI",sans-serif!important;' +
          'cursor:none!important;-webkit-tap-highlight-color:transparent!important}' +
        '#' + SHEET_ID + ' .pcn_panel{width:100%!important;max-width:640px!important;max-height:70vh!important;' +
          'background:#fff!important;color:#111!important;border-radius:14px 14px 0 0!important;' +
          'box-shadow:0 -4px 24px rgba(0,0,0,.25)!important;display:flex!important;flex-direction:column!important;' +
          'overflow:hidden!important;padding-bottom:max(0px,env(safe-area-inset-bottom))!important}' +
        '#' + SHEET_ID + ' .pcn_search{flex:0 0 auto!important;padding:10px 12px!important;' +
          'border-bottom:1px solid #eee!important;background:#fff!important}' +
        '#' + SHEET_ID + ' .pcn_search input{width:100%!important;box-sizing:border-box!important;' +
          'padding:12px 14px!important;font-size:16px!important;border:1px solid #ddd!important;' +
          'border-radius:10px!important;outline:none!important;background:#f6f6f6!important;color:#111!important;' +
          'cursor:text!important}' +
        '#' + SHEET_ID + ' .pcn_list{flex:1 1 auto!important;overflow-y:auto!important;' +
          '-webkit-overflow-scrolling:touch!important;padding:6px 0!important}' +
        '#' + SHEET_ID + ' .pcn_grp{padding:10px 20px 4px!important;font-size:12px!important;' +
          'font-weight:600!important;color:#888!important;text-transform:uppercase!important;letter-spacing:.04em!important}' +
        '#' + SHEET_ID + ' .pcn_opt{padding:14px 20px!important;font-size:17px!important;line-height:1.2!important;' +
          'display:flex!important;align-items:center!important;justify-content:space-between!important;' +
          'gap:12px!important;cursor:none!important;user-select:none!important}' +
        '#' + SHEET_ID + ' .pcn_opt.pcn_sel{color:#0b57d0!important;font-weight:600!important}' +
        '#' + SHEET_ID + ' .pcn_opt.pcn_dis{color:#bbb!important;pointer-events:none!important}' +
        '#' + SHEET_ID + ' .pcn_opt.pcn_grpitem{padding-left:34px!important}' +
        '#' + SHEET_ID + ' .pcn_hide{display:none!important}' +
        '#' + SHEET_ID + ' .pcn_empty{padding:20px!important;color:#999!important;text-align:center!important;font-size:15px!important}' +
        '#' + SHEET_ID + ' .pcn_opt .pcn_check{color:#0b57d0!important;font-size:18px!important}';
      (document.head || document.documentElement).appendChild(s);
    }

    function close() {
      const el = document.getElementById(SHEET_ID);
      if (el) el.remove();
      open = false;
    }

    function choose(sel, index) {
      if (index >= 0 && index < sel.options.length) {
        sel.selectedIndex = index;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
      try { sel.blur(); } catch (_) {}
    }

    function show(sel) {
      if (open) return;
      ensureStyle();
      open = true;
      const overlay = document.createElement('div');
      overlay.id = SHEET_ID;
      const panel = document.createElement('div');
      panel.className = 'pcn_panel';

      // The tap that OPENED the sheet fires its trailing click AFTER the overlay
      // exists, so that click would otherwise land on the overlay and close it
      // instantly (a "flash"). Its pointerdown happened on the <select>, before
      // the overlay existed — so only honor clicks that follow a FRESH pointer-
      // down on the overlay itself. Works for both a quick tap and a tap-hold,
      // with no timers.
      let armed = false;

      const list = document.createElement('div');
      list.className = 'pcn_list';
      const frag = document.createDocumentFragment();
      let selRow = null;

      // Walk children so <optgroup> labels are preserved. Rows carry data-idx
      // (the option's index) so ONE delegated click handler serves every row —
      // critical for 1000+ option selects.
      const kids = sel.children;
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        if (node.tagName === 'OPTGROUP') {
          const g = document.createElement('div');
          g.className = 'pcn_grp';
          g.textContent = node.label || '';
          frag.appendChild(g);
          const opts = node.children;
          for (let j = 0; j < opts.length; j++) addOpt(opts[j], true);
        } else if (node.tagName === 'OPTION') {
          addOpt(node, false);
        }
      }

      function addOpt(opt, grouped) {
        const row = document.createElement('div');
        const text = opt.textContent || opt.label || '';
        row.className = 'pcn_opt' + (grouped ? ' pcn_grpitem' : '') +
          (opt.selected ? ' pcn_sel' : '') + (opt.disabled ? ' pcn_dis' : '');
        if (!opt.disabled) row.dataset.idx = String(opt.index);
        row.dataset.text = text.toLowerCase();
        const label = document.createElement('span');
        label.textContent = text;
        row.appendChild(label);
        if (opt.selected) {
          const chk = document.createElement('span');
          chk.className = 'pcn_check';
          chk.textContent = '✓';
          row.appendChild(chk);
          selRow = row;
        }
        frag.appendChild(row);
      }
      list.appendChild(frag);

      // Filter box for long lists — type to narrow instead of scrolling.
      const optionCount = sel.options.length;
      if (optionCount > FILTER_THRESHOLD) {
        const search = document.createElement('div');
        search.className = 'pcn_search';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Search…';
        input.autocomplete = 'off';
        input.setAttribute('autocapitalize', 'off');
        const empty = document.createElement('div');
        empty.className = 'pcn_empty pcn_hide';
        empty.textContent = 'No matches';
        list.appendChild(empty);
        input.addEventListener('input', function () {
          const q = input.value.trim().toLowerCase();
          const rows = list.querySelectorAll('.pcn_opt');
          let shown = 0;
          for (let i = 0; i < rows.length; i++) {
            const match = !q || rows[i].dataset.text.indexOf(q) !== -1;
            rows[i].classList.toggle('pcn_hide', !match);
            if (match) shown++;
          }
          // While filtering, hide group headers (results become a flat list).
          const grps = list.querySelectorAll('.pcn_grp');
          for (let i = 0; i < grps.length; i++) grps[i].classList.toggle('pcn_hide', !!q);
          empty.classList.toggle('pcn_hide', shown > 0);
        });
        search.appendChild(input);
        panel.appendChild(search);
      }

      // A pointerdown ON the overlay = a deliberate interaction; arm from here.
      overlay.addEventListener('pointerdown', function () { armed = true; }, true);
      overlay.addEventListener('touchstart', function () { armed = true; }, true);
      overlay.addEventListener('mousedown', function () { armed = true; }, true);

      // One delegated click handler for the whole list.
      list.addEventListener('click', function (e) {
        if (!armed) { e.preventDefault(); e.stopPropagation(); return; }
        const row = e.target && e.target.closest && e.target.closest('.pcn_opt');
        if (!row || row.dataset.idx === undefined) return;
        e.preventDefault(); e.stopPropagation();
        choose(sel, Number(row.dataset.idx));
      }, true);

      panel.appendChild(list);
      overlay.addEventListener('click', function (e) {
        if (!armed) { e.preventDefault(); e.stopPropagation(); return; }
        if (e.target === overlay) { e.preventDefault(); e.stopPropagation(); close(); }
      }, true);
      overlay.appendChild(panel);
      (document.body || document.documentElement).appendChild(overlay);
      // Scroll the selected row into view.
      if (selRow && selRow.scrollIntoView) selRow.scrollIntoView({ block: 'center' });
    }

    // The native <select> only misbehaves under the mobile/magnify pipeline: the
    // GTK popup is an OS widget the CDP touch can't reach, so taps fall through.
    // This shim runs INSIDE the remote emulated Chromium, so navigator.max-
    // TouchPoints reflects the EMULATED environment, not the client device — the
    // emulator enables touch ONLY in magnify mode. So touch-on is the exact
    // "magnify is active" signal (true for phones AND large tablets like iPad
    // Pro), and touch-off means desktop viewing where the native control is fine.
    // A client touch-laptop viewing in desktop mode never turns touch on here.
    function isMobile() {
      return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    }
    function isPlainSelect(el) {
      return el && el.tagName === 'SELECT' && !el.multiple && !el.disabled && el.size <= 1;
    }

    // Suppress the native popup on the interactions that open it, then show ours.
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        if (!isMobile()) return;
        const sel = e.target && e.target.closest && e.target.closest('select');
        if (!isPlainSelect(sel)) return;
        e.preventDefault();
        e.stopPropagation();
        show(sel);
      }, true);
    });
    // Keyboard open (Enter/Space/ArrowDown while focused) → our sheet.
    document.addEventListener('keydown', function (e) {
      if (!isPlainSelect(document.activeElement)) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        show(document.activeElement);
      } else if (e.key === 'Escape' && open) {
        close();
      }
    }, true);
  })();

  // NO JS dialog override here, deliberately.
  //
  // An earlier version replaced window.alert/confirm/prompt so the extension could route
  // them to a viewer-drawn sheet (the bridge in content.js + proxy/dialog.go), and patched
  // Function.prototype.toString so the replacements still reported "[native code]".
  //
  // Removed for two reasons. The bridge it served is disabled (its synchronous XHR never
  // reaches the proxy — see DIALOG_BRIDGE_ENABLED in content.js), so the patches were
  // pure cost. And Fortress's own guidance is explicit: never combine it with JS
  // fingerprint patches. A patched Function.prototype.toString is precisely what CreepJS
  // scores as tampering, so this was working against the persona on every page load.
  //
  // JS dialogs are handled entirely over CDP instead (Page.javascriptDialogOpening in
  // proxy/emulate.go), which touches nothing in the page.

  // ---- window outer size must track the emulated viewport --------------------
  //
  // CDP's Emulation.setDeviceMetricsOverride rewrites innerWidth/innerHeight but
  // leaves outerWidth/outerHeight reporting the REAL kiosk window, so any magnify
  // session looks exactly like a browser with a docked DevTools panel.
  //
  // Measured against sms.ndmu.edu.ph, which ships the `disable-devtool` library with
  // detectors:"all". Its Size detector (type 2) is one comparison, quoted from the
  // library's own minified source:
  //
  //     200 < outerWidth  - innerWidth  * devicePixelRatio
  //     300 < outerHeight - innerHeight * devicePixelRatio
  //
  // At a 360x690 emulation with DPR 2 that is 1920 - 720 = 1200 > 200, so it fired on
  // every load, POSTed /auth/logout and ran location.replace('about:blank') — the
  // white screen, and a logged-out session with it. Isolated by experiment: the same
  // container renders the page in full (138KB of DOM) with MVD_EMULATOR_OFF=1, and
  // blanks the moment a 360x690 emulation is applied. Nothing to do with the CDP
  // attach itself.
  //
  // outer == inner is also the TRUTH for this browser: --kiosk has no tab strip, no
  // omnibox and no window frame, so there is no chrome for the outer box to be larger
  // by, and a real phone browser reports the two as equal.
  //
  // This is the ONE JS property patch in this file and a deliberate exception to the
  // no-JS-fingerprint-patches rule noted below. It is kept as narrow as possible: the
  // descriptor preserves the native shape (accessor, same enumerability, real setter,
  // configurable) so Object.getOwnPropertyDescriptor still looks normal. What it
  // cannot hide is getter.toString(), because hiding that needs
  // Function.prototype.toString patching — the specific thing Fortress warns against
  // and CreepJS scores as tampering. Left readable on purpose: a 1200px disagreement
  // between window and viewport is a far louder tell than a readable accessor.
  try {
    const nativeOf = (name) => {
      const d = Object.getOwnPropertyDescriptor(window, name);
      return { desc: d, get: d && d.get };
    };
    const spoof = (name, innerName) => {
      const { desc, get: native } = nativeOf(name);
      Object.defineProperty(window, name, {
        get: function () {
          const v = window[innerName];
          // Fall back to the real value if the viewport reads 0 (detached document),
          // so this never reports a nonsense size.
          if (typeof v === 'number' && v > 0) return v;
          return native ? native.call(window) : v;
        },
        set: (desc && desc.set) ? desc.set : function () {},
        enumerable: desc ? desc.enumerable : true,
        configurable: true,
      });
    };
    spoof('outerWidth', 'innerWidth');
    spoof('outerHeight', 'innerHeight');
  } catch (_) {}

  // ---- display-mode must read as a normal browser window ---------------------
  //
  // Chromium runs --kiosk, which makes matchMedia('(display-mode: fullscreen)')
  // match and '(display-mode: browser)' NOT match. A normal desktop Chrome — which
  // is exactly what this persona claims to be — reports the opposite: browser
  // matches, fullscreen does not. So the kiosk flag contradicts the persona on a
  // signal any page can read for free.
  //
  // ilearnu.lu.edu.ph reads it and renders an "Access Restricted — Standalone or
  // PWA mode detected" page instead of the site. Verified: overriding this makes
  // the real login page load (20KB, password form present) where the kiosk value
  // produced a 211-byte block. The server cannot see display-mode, so this is a
  // purely client-side gate — nothing server-side to fight.
  //
  // Narrow like the outer-size patch above: matchMedia keeps its identity and every
  // non-display-mode query is untouched (real MediaQueryList, real matches). Only
  // the display-mode family is rewritten to the browser-window answer, which is the
  // truthful one for the persona we present.
  try {
    const realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      const mql = realMatchMedia(q);
      if (typeof q === 'string' && /display-mode/i.test(q)) {
        // A normal browser window: display-mode:browser is the only match.
        const wantBrowser = /browser/i.test(q);
        try {
          Object.defineProperty(mql, 'matches', { get: () => wantBrowser, configurable: true });
        } catch (_) {}
      }
      return mql;
    };
  } catch (_) {}

  window.dispatchEvent(new CustomEvent('__pcnReady'));
})();
