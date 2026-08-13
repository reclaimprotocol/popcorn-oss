// popcorn-host.js — the HOST side of the embedded-viewer contract.
//
// Drop this into any page that embeds the Popcorn live view in an <iframe>,
// directly or through another one of our own frames. It does two jobs:
//
//   MEASURE  Report the soft keyboard's geometry to the frame below. This is the
//            one thing an embedded viewer structurally cannot do for itself:
//            navigator.virtualKeyboard stays mute in a cross-origin iframe
//            without allow="virtual-keyboard", and a subframe's visualViewport
//            does not reliably shrink when the keyboard opens. Without a rect the
//            viewer applies no lift and the focused remote field sits behind the
//            keys. Whoever is highest in the frame tree measures best, and
//            top-level visualViewport is NOT permission-gated — no allow=
//            attribute, no Permissions-Policy cooperation, nothing to negotiate
//            with the embedding page. It just works.
//
//   RELAY    Pass geometry down and viewer events up, so a CHAIN of frames works
//            the same as a single embed:
//
//              customer page  (attach -> measures, posts down)
//                portal frame (attach -> relays down, re-emits up)
//                  liveview   (applies the lift)
//
//            An intermediate frame does not interpret geometry; it forwards it.
//            Every hop is the same script in a different mode, so depth is
//            unbounded and no hop needs to know the whole topology.
//
// Usage — the SAME call at every level. Mode resolves itself (see `mode` below):
//
//   const host = PopcornHost.attach(iframeEl, { childOrigin: CHILD_ORIGIN });
//   host.on('frame', () => hideLoadingCover());
//   host.on('kbdstate', ({ active }) => setChromeHidden(active));
//   host.toggleMagnify();
//   host.destroy();
//
// In the real topology that is two call sites, one package:
//
//   customer page  SDK  -> attach(portalIframe)     resolves to MEASURE (top-level)
//     portal       app  -> attach(liveviewIframe)   resolves to RELAY (parent measures)
//       liveview   layer                            applies the lift
//
// and the portal's call is UNCHANGED when it runs top-level (direct link) or when a
// customer hand-rolls the embed without our SDK — it resolves to MEASURE in both,
// so the viewer is never left with no geometry. Events reach .on() listeners in
// every mode, so a relaying frame still drives its own UI while forwarding.
//
// The child must be loaded with ?parentOrigin=<this page's origin> or it will
// ignore everything we send (its inbound policy is fail-closed — unauthenticated
// geometry could wedge its lift and unauthenticated paste could type into the
// remote session). attach() warns when it sees a HELLO from a child that hasn't
// been configured that way, because a silent no-op is the worst failure mode
// here: the viewer looks alive, only the keyboard misbehaves.

(function (global) {
  'use strict';

  var PROTOCOL = 1;

  // Re-post geometry on a slow heartbeat even when nothing changes. The viewer
  // ages host samples out after 8s and falls back to its own detectors, which is
  // the right behavior if this page dies — but it means a quiet period with the
  // keyboard up must not look like death. Comfortably inside that window.
  var HEARTBEAT_MS = 3000;

  // Ignore sub-threshold viewport deltas. iOS reports fractional visualViewport
  // heights that jitter by a pixel or so during scroll momentum; forwarding
  // those would re-post (and re-lift) continuously for no visible gain.
  var MIN_DELTA_PX = 8;

  // How long an embedded host waits for geometry from ITS parent before deciding
  // nobody above is measuring and doing it itself. Long enough that a real
  // upstream host (which primes on the child's HELLO, then heartbeats every 3s)
  // always wins the race; short enough that a hand-rolled embed isn't left
  // without a lift for a noticeable time.
  var UPSTREAM_GRACE_MS = 2000;

  function attach(iframeEl, opts) {
    opts = opts || {};
    if (!iframeEl || !iframeEl.tagName || iframeEl.tagName !== 'IFRAME') {
      throw new Error('PopcornHost.attach: first argument must be an <iframe> element');
    }
    // Where we post TO. '*' works but means any page that manages to occupy the
    // frame can read our geometry; pass childOrigin in production.
    var childOrigin = opts.childOrigin || '*';

    // Mode. 'auto' (the default, and what every caller should use) resolves as:
    //
    //   top-level          -> MEASURE. We're the best available measurer; nobody
    //                         above us exists. This is the portal opened directly.
    //   embedded, parent    -> RELAY. An upstream host (our SDK in the customer's
    //   is measuring           page) sees the real top-level viewport, so forward
    //                          its numbers rather than our own possibly-blind ones.
    //   embedded, silence   -> MEASURE anyway, after UPSTREAM_GRACE_MS. This is the
    //                          customer who hand-rolled the <iframe> without our
    //                          SDK: our subframe reads may still be good (Chromium
    //                          with the allow= attribute), and a blind guess that
    //                          reports occluded=0 is no worse than sending nothing.
    //
    // Explicit opts.relay/opts.measure force a mode, for tests and for a host that
    // knows its own topology (the harness uses relay to prove forwarding works).
    var mode = opts.relay ? 'relay' : (opts.measure ? 'measure' : 'auto');
    var embedded;
    try { embedded = global !== global.top; } catch (_) { embedded = true; }
    // Resolved stance: relay until proven otherwise when embedded under 'auto'.
    var relay = mode === 'relay' || (mode === 'auto' && embedded);
    var upstreamSeen = false;
    var graceTimer = null;
    var listeners = {};
    var lastSent = null;
    var heartbeat = null;
    var destroyed = false;
    var childHello = null;

    function post(type, data) {
      if (destroyed) return;
      var win = iframeEl.contentWindow;
      if (!win) return; // not loaded yet (or already torn down)
      try {
        var msg = { type: type };
        if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k];
        win.postMessage(msg, childOrigin);
      } catch (_) {}
    }

    function emit(name, detail) {
      var fns = listeners[name];
      if (!fns) return;
      for (var i = 0; i < fns.length; i++) {
        try { fns[i](detail); } catch (_) {}
      }
    }

    // ---- MEASURE -----------------------------------------------------------
    // occludedBottom is the height the keyboard covers; visibleHeight is what's
    // left. Prefer the VirtualKeyboard API when this document actually has it
    // (Chromium, and only where permitted) since it reports the keyboard rect
    // explicitly; otherwise derive it from the visual viewport, which is the
    // only signal iOS Safari offers. offsetTop matters: iOS shifts the visual
    // viewport rather than only shrinking it, so height alone under-reports.
    function measure() {
      var innerH = global.innerHeight || 0;
      var vk = global.navigator && global.navigator.virtualKeyboard;
      if (vk && vk.boundingRect && vk.boundingRect.height > 0) {
        return { visibleHeight: innerH - vk.boundingRect.height, occludedBottom: vk.boundingRect.height };
      }
      var vv = global.visualViewport;
      if (vv) {
        var occluded = Math.max(0, innerH - vv.height - (vv.offsetTop || 0));
        // Under ~50px is not a keyboard — it's a URL bar collapsing, a pinch, or
        // fractional rounding. Report it as "no keyboard" so the viewer clears
        // its lift instead of nudging the page around.
        if (occluded < 50) return { visibleHeight: innerH, occludedBottom: 0 };
        return { visibleHeight: vv.height, occludedBottom: occluded };
      }
      return { visibleHeight: innerH, occludedBottom: 0 };
    }

    function sendGeometry(force) {
      if (relay) return; // a relaying frame forwards its parent's numbers, never its own
      if (destroyed) return;
      var g = measure();
      if (!force && lastSent &&
          Math.abs(g.visibleHeight - lastSent.visibleHeight) < MIN_DELTA_PX &&
          Math.abs(g.occludedBottom - lastSent.occludedBottom) < MIN_DELTA_PX) {
        return;
      }
      lastSent = g;
      post('POPCORN_HOST_GEOMETRY', g);
    }

    function onViewportChange() { sendGeometry(false); }

    // ---- Inbound: viewer events (and, when relaying, our own parent) --------
    function onMessage(e) {
      var d = e.data;
      if (!d || typeof d.type !== 'string') return;

      // From the child viewer (or a deeper relay) — bubble it to our listeners
      // AND, if we're a middle frame, keep it travelling up.
      //
      // Checked on BOTH source and origin: source alone would keep trusting the
      // frame after a navigation away from the viewer (a redirect, an OAuth hop
      // that replaced the document), and these messages drive analytics counters
      // and stream state. Skipped only when childOrigin was left as '*', i.e. the
      // caller explicitly opted out of pinning.
      var fromChild = false;
      try {
        fromChild = e.source === iframeEl.contentWindow &&
                    (childOrigin === '*' || e.origin === childOrigin);
      } catch (_) { fromChild = false; }

      if (fromChild) {
        switch (d.type) {
          case 'POPCORN_HELLO':
            childHello = d;
            if (d.protocol !== PROTOCOL) {
              // Loud, not silent: a skewed pod image and host script will
              // misbehave in ways that look like device bugs.
              logWarn('protocol mismatch: host=' + PROTOCOL + ' viewer=' + d.protocol);
            }
            // vk:false means the viewer has no keyboard rect of its own, so OUR
            // geometry is the only thing that can produce a lift. Worth saying out
            // loud, because if the viewer was also loaded without ?parentOrigin=<us>
            // it will ignore what we send and the only symptom is a keyboard that
            // covers the focused field.
            if (!d.vk) logInfo('viewer has no usable VirtualKeyboard API — host geometry is load-bearing for the keyboard lift');
            sendGeometry(true); // prime it immediately, don't wait for a keyboard
            emit('hello', d);
            break;
          case 'POPCORN_VIEWPORT': emit('viewport', d); break;
          case 'POPCORN_CONNECT': emit('connect', d); break;
          case 'POPCORN_FRAME': emit('frame', d); break;
          case 'POPCORN_DISCONNECT': emit('disconnect', d); break;
          case 'POPCORN_ERROR': emit('error', d); break;
          case 'POPCORN_KBD_STATE': emit('kbdstate', d); break;
          case 'POPCORN_INPUT_DRIFT': emit('inputdrift', d); break;
          default: return;
        }
        if (relay) {
          // Keep it moving up. '*' because our own parent's origin is the
          // integrator's page, which we don't get to pin.
          try { global.parent.postMessage(d, '*'); } catch (_) {}
        }
        return;
      }

      // From our own parent: geometry and commands travel down. Accepted whenever
      // we're embedded — not only while relaying — because an upstream host that
      // starts late (SDK loaded async, or a frame that was hidden) must be able to
      // TAKE OVER from our fallback measuring: it sees the true top-level viewport
      // and we may be blind.
      if (!embedded || mode === 'measure') return;
      var fromParent = false;
      try { fromParent = e.source === global.parent; } catch (_) { fromParent = false; }
      if (!fromParent) return;
      if (d.type === 'POPCORN_HOST_GEOMETRY' || d.type === 'POPCORN_TOGGLE_MAGNIFY' ||
          d.type === 'POPCORN_TOGGLE_KBD' || d.type === 'POPCORN_PASTE') {
        if (d.type === 'POPCORN_HOST_GEOMETRY' && !upstreamSeen) {
          upstreamSeen = true;
          if (graceTimer) { global.clearTimeout(graceTimer); graceTimer = null; }
          if (!relay) { stopMeasuring(); relay = true; logInfo('upstream host is measuring — switching to relay'); }
        }
        post(d.type, d);
      }
    }

    function logWarn(m) { try { if (global.console) global.console.warn('[popcorn-host] ' + m); } catch (_) {} }
    function logInfo(m) { try { if (global.console) global.console.info('[popcorn-host] ' + m); } catch (_) {} }

    var measuring = false;

    function startMeasuring() {
      if (measuring) return;
      measuring = true;
      if (global.visualViewport) {
        global.visualViewport.addEventListener('resize', onViewportChange);
        global.visualViewport.addEventListener('scroll', onViewportChange);
      }
      global.addEventListener('resize', onViewportChange);
      var vkApi = global.navigator && global.navigator.virtualKeyboard;
      if (vkApi) {
        // overlaysContent stops the browser resizing OUR layout for the keyboard,
        // so the numbers we report describe the keyboard and not a reflow.
        try { vkApi.overlaysContent = true; } catch (_) {}
        try { vkApi.addEventListener('geometrychange', onViewportChange); } catch (_) {}
      }
      heartbeat = global.setInterval(function () { sendGeometry(true); }, HEARTBEAT_MS);
      // The child may already be loaded (a cached frame, or attach() called late).
      sendGeometry(true);
    }

    function stopMeasuring() {
      if (!measuring) return;
      measuring = false;
      if (global.visualViewport) {
        global.visualViewport.removeEventListener('resize', onViewportChange);
        global.visualViewport.removeEventListener('scroll', onViewportChange);
      }
      global.removeEventListener('resize', onViewportChange);
      var vkApi = global.navigator && global.navigator.virtualKeyboard;
      if (vkApi) { try { vkApi.removeEventListener('geometrychange', onViewportChange); } catch (_) {} }
      if (heartbeat) { global.clearInterval(heartbeat); heartbeat = null; }
      lastSent = null; // next send must not be suppressed as an unchanged delta
    }

    global.addEventListener('message', onMessage);
    if (!relay) {
      startMeasuring();
    } else if (mode === 'auto') {
      // Embedded: give an upstream host a moment to prove it exists. If nothing
      // arrives, measure ourselves rather than leaving the viewer with no lift at
      // all — a hand-rolled customer embed with no SDK above us.
      graceTimer = global.setTimeout(function () {
        graceTimer = null;
        if (upstreamSeen || destroyed) return;
        relay = false;
        logInfo('no upstream geometry after ' + UPSTREAM_GRACE_MS + 'ms — measuring locally');
        startMeasuring();
      }, UPSTREAM_GRACE_MS);
    }

    return {
      /** Subscribe to viewer events: hello|viewport|connect|frame|disconnect|error|kbdstate|inputdrift */
      on: function (name, fn) {
        (listeners[name] || (listeners[name] = [])).push(fn);
        return this;
      },
      /** Force a geometry re-send (e.g. after your own layout change). */
      syncGeometry: function () { sendGeometry(true); },
      /** Drive the viewer's magnify/fit toggle from your own button. */
      toggleMagnify: function () { post('POPCORN_TOGGLE_MAGNIFY', null); },
      /** Drive the viewer's keyboard toggle from your own button. */
      toggleKeyboard: function () { post('POPCORN_TOGGLE_KBD', null); },
      /**
       * Paste text into the focused remote field. Read the clipboard HERE, in the
       * gesture handler of your own button: clipboard permission in a nested
       * cross-origin frame is the most restricted path (iOS especially), whereas
       * this page usually already has it.
       */
      paste: function (text) { if (text) post('POPCORN_PASTE', { text: String(text) }); },
      /** What the viewer reported about itself, or null if it hasn't said hello. */
      viewerInfo: function () { return childHello; },
      /** 'measure' | 'relay' — the stance actually in effect right now. */
      mode: function () { return relay ? 'relay' : 'measure'; },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        global.removeEventListener('message', onMessage);
        if (graceTimer) { global.clearTimeout(graceTimer); graceTimer = null; }
        stopMeasuring();
        listeners = {};
      },
    };
  }

  global.PopcornHost = { attach: attach, PROTOCOL: PROTOCOL };
})(typeof window !== 'undefined' ? window : this);
