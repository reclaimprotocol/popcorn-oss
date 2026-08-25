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

  // ---- The LAYOUT contract ------------------------------------------------
  //
  // The third job of this script, and the one that shows up as "the remote UI is
  // blurry on Android" rather than as a keyboard bug.
  //
  // The viewer's framebuffer is a bitmap. Whatever raster scale the embedding
  // page's compositor picks for the iframe's layer is the scale that bitmap is
  // resampled at, and mobile compositors pick a scale BELOW the device scale for a
  // layer they consider cheap to redraw — one that is transformed, filtered,
  // contained, promoted, or sized by a flex/grid parent next to a scrolling
  // sibling. Every measurable number stays identical (framebuffer 980px, canvas
  // 393 CSS px, zoom 1.00, byte-identical to a sharp top-level tab) and the stream
  // still comes out visibly soft, which is what makes this so hard to attribute:
  // there is nothing to read in the viewer, only in the page above it.
  //
  // So the contract is a property of the EMBEDDER, and this is where an embedder
  // can be told it broke it:
  //
  //   * the viewer iframe is a plain fixed full-viewport layer, a direct child of
  //     <body>, with no border and no wrapper;
  //   * page chrome is LAYERED OVER it (position:fixed + z-index), never a layout
  //     sibling that resizes it;
  //   * no ancestor carries a transform / zoom / filter / containment / opacity /
  //     will-change, and none of them scrolls or animates.
  //
  // layer() applies the first rule; auditLayout() checks all three and says which
  // one was broken, in codes only — no text, no URLs, no user data.
  var LAYER_CSS = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;' +
    'border:0;margin:0;padding:0;display:block;';

  // Ancestor properties that can put the iframe on a layer the compositor is free
  // to rasterise below device scale. Checked as COMPUTED values, so a class, an
  // inline style and a running animation all read the same.
  //
  // isRoot marks <body>/<html>. Their transforms and filters matter exactly as much
  // as anyone else's, but their SCROLLING does not — document scrolling is not what
  // puts a fixed layer on a small raster, and `html { overflow-y: scroll }` is
  // common enough that flagging it would train integrators to ignore the warning.
  function inspect(el, isDirectParent, out, isRoot) {
    var cs;
    try { cs = global.getComputedStyle(el); } catch (_) { return; }
    if (!cs) return;
    function flag(code) { if (out.indexOf(code) < 0) out.push(code); }
    var none = function (v) { return !v || v === 'none'; };
    if (!none(cs.transform) || !none(cs.rotate) || !none(cs.scale) || !none(cs.translate)) flag('transform');
    if (!none(cs.perspective)) flag('perspective');
    if (!none(cs.filter) || !none(cs.backdropFilter)) flag('filter');
    if (!none(cs.clipPath) || (cs.maskImage && cs.maskImage !== 'none')) flag('clip');
    // zoom serialises as '1' (or 'normal' in older engines) when unset.
    if (cs.zoom && cs.zoom !== '1' && cs.zoom !== 'normal') flag('zoom');
    if (cs.contain && cs.contain !== 'none' && cs.contain !== 'normal') flag('contain');
    if (cs.contentVisibility && cs.contentVisibility !== 'visible') flag('content-visibility');
    if (cs.willChange && /transform|opacity|filter/.test(cs.willChange)) flag('will-change');
    if (cs.opacity && parseFloat(cs.opacity) < 1) flag('opacity');
    if (!isRoot && /(auto|scroll)/.test(String(cs.overflowX) + ' ' + String(cs.overflowY))) flag('scroll-ancestor');
    // Only the DIRECT parent gets to size the iframe, so only its formatting
    // context matters for "something else on the page is shrinking the stream".
    if (isDirectParent && /(flex|grid)/.test(String(cs.display))) flag('flex-or-grid-parent');
  }

  /**
   * Check the embedding of `iframeEl` against the layout contract.
   *
   * Returns { ok, issues, depth, css, dpr }. `issues` is a list of short codes
   * (see inspect() above plus 'not-fixed', 'border', 'not-full-viewport',
   * 'nested', 'resized'); nothing derived from page content, URLs or user input is
   * ever included, so the result is safe to log and to forward.
   */
  function auditLayout(iframeEl) {
    var issues = [];
    var depth = 0;
    var w = 0, h = 0;
    try {
      var cs = global.getComputedStyle(iframeEl);
      if (cs) {
        if (cs.position !== 'fixed') issues.push('not-fixed');
        if (parseFloat(cs.borderTopWidth || '0') > 0 || parseFloat(cs.borderLeftWidth || '0') > 0) issues.push('border');
      }
      inspect(iframeEl, false, issues);
      var doc = global.document;
      var node = iframeEl.parentNode;
      var direct = true;
      while (node && node.nodeType === 1) {
        var isRoot = node === doc.body || node === doc.documentElement;
        inspect(node, direct, issues, isRoot);
        // depth counts WRAPPERS — the elements an embedder added. <body> and <html>
        // are always there, so counting them would make the clean case read as 2.
        if (!isRoot) depth++;
        direct = false;
        if (node === doc.documentElement) break;
        node = node.parentNode;
      }
      if (iframeEl.parentNode !== global.document.body) issues.push('nested');
      var r = iframeEl.getBoundingClientRect();
      w = r.width; h = r.height;
      // The layer must BE the viewport. A stream rendered into a box that is a few
      // px short of it is being scaled by a fractional factor on every axis it
      // misses, which is its own softness on top of the raster-scale question.
      // The LAYOUT viewport (innerWidth/innerHeight) is what a fixed inset:0 box
      // matches. visualViewport is deliberately not the reference: it shrinks under
      // a pinch-zoom, which would report a compliant embed as broken.
      var vw = global.innerWidth || (global.visualViewport && global.visualViewport.width) || 0;
      var vh = global.innerHeight || 0;
      // No viewport to compare against (a detached or hidden document) is not a
      // finding — skip the check rather than inventing one.
      if (vw && vh && (Math.abs(w - vw) > 1.5 || h < vh - 1.5)) issues.push('not-full-viewport');
    } catch (_) {}
    return {
      ok: issues.length === 0,
      issues: issues,
      depth: depth,
      css: { w: Math.round(w), h: Math.round(h) },
      dpr: global.devicePixelRatio || 1,
      top: (function () { try { return global === global.top; } catch (_) { return false; } })(),
    };
  }

  /**
   * Is this frame showing something we would destroy by moving it?
   *
   * NOT the same question as "does it have a document". A parsed <iframe> ALWAYS
   * has a contentDocument — the blank one every engine gives it before anything
   * navigates it — so testing for that made layer() treat a fresh frame as a live
   * session and refuse to move it out of the embedder's wrapper. The documented
   * recipe (call layer() BEFORE setting src) therefore did nothing in a real
   * browser while passing in a stub, and the audit went on reporting 'nested' on
   * pages that had followed the instructions exactly.
   *
   * So ask where the frame IS. A src attribute means it is going somewhere; a
   * contentWindow that has left about:blank means it already went. A cross-origin
   * frame throws on the location read, which is itself proof it navigated.
   */
  function isLive(iframeEl) {
    if (iframeEl.getAttribute('src')) return true;
    try {
      var w = iframeEl.contentWindow;
      if (!w) return false;               // not attached to a document yet
      var href = w.location && w.location.href;
      return !!href && href !== 'about:blank';
    } catch (_) {
      return true;                        // cross-origin: definitely navigated
    }
  }

  /**
   * Make `iframeEl` the plain fixed full-viewport layer the contract asks for.
   *
   * Reparenting an iframe to <body> RELOADS it in every engine, which would
   * restart a live session — so that half only happens while the frame is still
   * blank (call this BEFORE setting src, which is the natural order anyway). An
   * already-loaded frame in a wrapper is reported by auditLayout() as 'nested'
   * instead of being silently torn down.
   */
  function layer(iframeEl, opts) {
    opts = opts || {};
    if (!iframeEl || iframeEl.tagName !== 'IFRAME') {
      throw new Error('PopcornHost.layer: first argument must be an <iframe> element');
    }
    var doc = global.document;
    if (iframeEl.parentNode !== doc.body) {
      if (!isLive(iframeEl)) {
        doc.body.appendChild(iframeEl);
      } else {
        logWarn('layer(): iframe is inside a wrapper and already loaded — not reparenting a live frame. ' +
          'Move it to a direct child of <body> in your own markup, or call layer() before setting src.');
      }
    }
    iframeEl.style.cssText = LAYER_CSS + (opts.background ? 'background:' + opts.background + ';' : '') +
      (opts.zIndex != null ? 'z-index:' + opts.zIndex + ';' : '');
    // A subframe of ours must never scroll: the stream fills it exactly, and a
    // scrollable box is one of the shapes that gets rasterised small.
    try { iframeEl.setAttribute('scrolling', 'no'); } catch (_) {}
    return iframeEl;
  }

  // Viewer-facing query parameters, forwarded verbatim through EVERY embedding hop.
  //
  // A chain drops what it does not name, and a dropped parameter is invisible:
  // the viewer just runs with its default, so `quality=9` reaching only the middle
  // frame looks exactly like `quality=9` being applied. That is a bug this repo has
  // already shipped once. Keep the list here — one place, shared by every hop —
  // rather than re-listing it per embedder.
  var VIEWER_PARAMS = [
    // stream + emulation
    'magnify', 'quality', 'compression', 'resize', 'fill', 'fbcap', 'fixedw', 'smooth',
    // fbscale: the supersampled framebuffer (kbd/fbscale.js). The viewer defaults to
    // 1x, so this parameter is the ONLY way to turn it on — which makes it exactly the
    // one you cannot afford to have die at a hop while A/B-ing a sharpness complaint
    // (a dropped ?fbscale=2 looks identical to one that had no effect).
    'fbscale',
    // session / transport
    'password', 'path', 'view_only', 'shared', 'show_dot', 'reconnect', 'reconnect_delay',
    // keyboard / IME behaviour
    'iosbridge', 'stateless', 'mirror', 'mirrorbar',
    // diagnostics (all opt-in, all structural-only)
    'diag', 'kbdlog', 'kbddebug', 'e2e',
  ];

  /**
   * The subset of `search` (default: this page's) that belongs to the viewer,
   * re-encoded as 'k=v' strings ready to join with '&'. Order follows
   * VIEWER_PARAMS so a URL is stable across hops and comparable in a log.
   */
  function forwardParams(search) {
    var q;
    try { q = new URLSearchParams(search == null ? global.location.search : search); } catch (_) { return []; }
    var out = [];
    for (var i = 0; i < VIEWER_PARAMS.length; i++) {
      var k = VIEWER_PARAMS[i];
      var v = q.get(k);
      if (v !== null) out.push(k + '=' + encodeURIComponent(v));
    }
    return out;
  }

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

  function logWarn(m) { try { if (global.console) global.console.warn('[popcorn-host] ' + m); } catch (_) {} }
  function logInfo(m) { try { if (global.console) global.console.info('[popcorn-host] ' + m); } catch (_) {} }

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
    // On by default: it costs one getComputedStyle walk per lifecycle event and it
    // is the only way an embedder ever learns it broke the layout contract.
    var auditOn = opts.audit !== false;
    // Accept the legacy `parent-viewport` geometry message from our own parent (see
    // onMessage). On by default: a portal that still posts it is the case this
    // exists for, and a page that means something else by that message type can
    // pass { legacyGeometry: false }.
    var legacyGeometry = opts.legacyGeometry !== false;
    var legacyLogged = false;
    var legacyBaselineHeight = 0;
    var legacyOccluding = false;
    var embedded;
    try { embedded = global !== global.top; } catch (_) { embedded = true; }
    // Resolved stance: relay until proven otherwise when embedded under 'auto'.
    var relay = mode === 'relay' || (mode === 'auto' && embedded);
    var upstreamSeen = false;
    var graceTimer = null;
    var listeners = {};
    var lastSent = null;
    var heartbeat = null;
    // Have our OWN measurements ever seen the keyboard? Gates the silence above:
    // once we have measured a real occlusion, our 0 means "dismissed" and must be
    // sent, or the keyboard could never be torn down through this bridge.
    var everOccluded = false;
    // Safari can eventually shrink window.innerHeight to the already-shrunk
    // visualViewport height while the keyboard remains docked.  Keep the last
    // no-keyboard layout height for the active occlusion session; otherwise the
    // live innerHeight-vv.height delta collapses to zero after the first key.
    var layoutBaselineHeight = global.innerHeight || 0;
    var layoutBaselineWidth = global.innerWidth || 0;
    var measuredOccluding = false;
    // A fixed iframe declared as height:100% still follows Safari's shrinking
    // layout viewport.  After the first character WebKit can collapse that box
    // to the area above the keyboard, exposing the embedder's background as a
    // large black band.  Remember the pre-keyboard box and pin it in CSS pixels
    // for the keyboard session.  Geometry/lift decides what PART is visible;
    // resizing the stream itself is both redundant and visibly destructive.
    var pinKeyboardHeight = opts.pinKeyboardHeight !== false;
    var frameBaselineHeight = 0;
    var frameBaselineWidth = 0;
    var framePinned = false;
    var frameRestoreHeight = '';
    var frameRestoreBottom = '';
    var frameRestoreTop = '';
    var frameRestoreTransform = '';
    try {
      var initialFrameRect = iframeEl.getBoundingClientRect();
      frameBaselineHeight = initialFrameRect.height || layoutBaselineHeight;
      frameBaselineWidth = initialFrameRect.width || layoutBaselineWidth;
    } catch (_) {
      frameBaselineHeight = layoutBaselineHeight;
      frameBaselineWidth = layoutBaselineWidth;
    }
    var blindLogged = false;
    var destroyed = false;
    var childHello = null;
    // A viewer announces itself at boot, but framework mounts can attach this
    // host listener after that one-shot message.  Ask for the hello immediately
    // and retry briefly until it lands; this removes the otherwise-visible wait
    // for a geometry heartbeat on the first focused field.
    var helloRetry = null;
    var helloAttempt = 0;
    var onFrameLoad = null;
    var HELLO_DELAYS = [100, 200, 350, 600, 1000, 1500];

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

    function stopHelloRetry() {
      if (helloRetry) { global.clearTimeout(helloRetry); helloRetry = null; }
    }

    function requestHello() {
      if (destroyed || childHello) return;
      post('POPCORN_HELLO_REQUEST', null);
      if (helloAttempt >= HELLO_DELAYS.length) return;
      var delay = HELLO_DELAYS[helloAttempt++];
      helloRetry = global.setTimeout(requestHello, delay);
    }

    function beginHelloHandshake() {
      stopHelloRetry();
      helloAttempt = 0;
      requestHello();
    }

    function emit(name, detail) {
      var fns = listeners[name];
      if (!fns) return;
      for (var i = 0; i < fns.length; i++) {
        try { fns[i](detail); } catch (_) {}
      }
    }

    function frameHeightNow() {
      try { return iframeEl.getBoundingClientRect().height || 0; } catch (_) { return 0; }
    }

    function pinFrameForKeyboard(active) {
      if (!pinKeyboardHeight) return;
      var cs;
      try { cs = global.getComputedStyle(iframeEl); } catch (_) { return; }
      if (!cs || cs.position !== 'fixed') return;

      if (active) {
        if (!framePinned) {
          var rect;
          try { rect = iframeEl.getBoundingClientRect(); } catch (_) { rect = null; }
          if (rect && rect.width && frameBaselineWidth && Math.abs(rect.width - frameBaselineWidth) > 8) {
            // A rotation is a new layout.  Prefer the current box only when it has
            // not already collapsed below the pre-keyboard layout baseline.
            frameBaselineWidth = rect.width;
            if (rect.height >= layoutBaselineHeight - 8) frameBaselineHeight = rect.height;
          } else if (rect && rect.height > frameBaselineHeight) {
            frameBaselineHeight = rect.height;
          }
          frameBaselineHeight = Math.max(frameBaselineHeight, layoutBaselineHeight);
          if (!(frameBaselineHeight > 0)) return;
          frameRestoreHeight = iframeEl.style.height || '';
          frameRestoreBottom = iframeEl.style.bottom || '';
          frameRestoreTop = iframeEl.style.top || '';
          frameRestoreTransform = iframeEl.style.transform || '';
          iframeEl.style.height = Math.round(frameBaselineHeight) + 'px';
          // top + bottom + an explicit height is over-constrained.  Say which two
          // edges own the box so WebKit cannot choose the shrunken bottom inset.
          iframeEl.style.bottom = 'auto';
          framePinned = true;
        }
        // iOS pans the visual viewport after the first key (offsetTop becomes
        // roughly the keyboard height).  Fixed content remains in layout-viewport
        // coordinates, so without this compensation the entire 714px iframe moves
        // up ~337px and its bottom exposes the host background.  Keep its top at
        // the visual viewport's top; the viewer's own lift still positions the
        // remote field within the visible 377px.  Use an integer compositor
        // translation only when Safari actually pans.  The normal proxy placement
        // keeps offsetTop at zero, so the iframe retains the transform-free layout
        // contract and its native raster scale.
        var vv = global.visualViewport;
        var visualTop = Math.round(vv ? (vv.offsetTop || 0) : 0);
        iframeEl.style.top = frameRestoreTop;
        iframeEl.style.transform = visualTop
          ? 'translate3d(0,' + visualTop + 'px,0)'
          : frameRestoreTransform;
        return;
      }

      if (!framePinned) {
        var idleHeight = frameHeightNow();
        if (idleHeight > 0) frameBaselineHeight = idleHeight;
        return;
      }
      iframeEl.style.height = frameRestoreHeight;
      iframeEl.style.bottom = frameRestoreBottom;
      iframeEl.style.top = frameRestoreTop;
      iframeEl.style.transform = frameRestoreTransform;
      framePinned = false;
      var restoredHeight = frameHeightNow();
      if (restoredHeight > 0) frameBaselineHeight = restoredHeight;
    }

    function annotateGeometry(g) {
      var vv = global.visualViewport;
      g.rawInnerHeight = global.innerHeight || 0;
      g.rawViewportHeight = vv ? vv.height : 0;
      g.rawOffsetTop = vv ? (vv.offsetTop || 0) : 0;
      g.layoutBaselineHeight = layoutBaselineHeight;
      g.frameHeight = frameHeightNow();
      g.framePinned = framePinned ? 1 : 0;
      return g;
    }

    // ---- MEASURE -----------------------------------------------------------
    // occludedBottom is the height the keyboard covers; visibleHeight is what's
    // left. Prefer the VirtualKeyboard API when this document actually has it
    // (Chromium, and only where permitted) since it reports the keyboard rect
    // explicitly; otherwise derive it from the visual viewport, which is the
    // only signal iOS Safari offers.  The keyboard reduces visualViewport.height;
    // offsetTop is the page's pan/scroll position and must NOT be subtracted from
    // the keyboard height.  iOS raises offsetTop while keeping a lower-page field
    // visible during typing; subtracting it made a still-docked keyboard report
    // occludedBottom=0 and caused the viewer to expose a large black gap.
    function measure() {
      var innerH = global.innerHeight || 0;
      var innerW = global.innerWidth || 0;
      if (layoutBaselineWidth && Math.abs(innerW - layoutBaselineWidth) > 8) {
        // Rotation/posture change: relearn in the new width.  If the keyboard is
        // already visible, vv.height will still be smaller and latch it below.
        layoutBaselineWidth = innerW;
        layoutBaselineHeight = innerH;
        measuredOccluding = false;
      } else {
        layoutBaselineWidth = innerW;
        if (innerH > layoutBaselineHeight) layoutBaselineHeight = innerH;
      }
      var vk = global.navigator && global.navigator.virtualKeyboard;
      if (vk && vk.boundingRect && vk.boundingRect.height > 0) {
        measuredOccluding = true;
        return { visibleHeight: innerH - vk.boundingRect.height, occludedBottom: vk.boundingRect.height };
      }
      var vv = global.visualViewport;
      if (vv) {
        // When both viewports agree and no keyboard session has been observed,
        // this is ordinary page/browser-chrome geometry.  Relearn downward as
        // well so an expanded URL bar is not mistaken for a keyboard.
        if (!measuredOccluding && Math.abs(innerH - vv.height) < 50) {
          layoutBaselineHeight = innerH;
          return { visibleHeight: innerH, occludedBottom: 0 };
        }
        var occluded = Math.max(0, Math.max(layoutBaselineHeight, innerH) - vv.height);
        // Under ~50px is not a keyboard — it's a URL bar collapsing, a pinch, or
        // fractional rounding. Report it as "no keyboard" so the viewer clears
        // its lift instead of nudging the page around.
        if (occluded < 50) {
          measuredOccluding = false;
          if (Math.abs(innerH - vv.height) < 50) layoutBaselineHeight = innerH;
          return { visibleHeight: innerH, occludedBottom: 0 };
        }
        measuredOccluding = true;
        return { visibleHeight: vv.height, occludedBottom: occluded };
      }
      return { visibleHeight: innerH, occludedBottom: 0 };
    }

    function sendGeometry(force) {
      if (relay) return; // a relaying frame forwards its parent's numbers, never its own
      if (destroyed) return;
      var g = measure();
      pinFrameForKeyboard(g.occludedBottom > 0);
      annotateGeometry(g);
      // A FALLBACK measurer (embedded, nobody above us proved it measures) must
      // never assert "there is no keyboard". Our visualViewport is a subframe's: it
      // does not reliably shrink when the keyboard opens, so occludedBottom:0 from
      // here can mean either "dismissed" or "structurally blind", and we cannot
      // tell which. Sending it anyway is what broke the deployed portal — the
      // viewer treats a fresh host sample as authoritative, mutes its own
      // detectors, and gets no lift, no pan budget and an off-screen echo pill,
      // i.e. a keyboard that looks broken and typing that looks dead.
      //
      // So while we see nothing, we say nothing, and the viewer's local detectors
      // stay on the field. The moment we DO see a real occlusion we start posting
      // and take over properly. (A top-level measurer is exempt: its 0 is a real
      // measurement, and it is the one that must be able to report a dismissal.)
      if (embedded && g.occludedBottom <= 0 && !everOccluded) {
        if (!blindLogged) {
          blindLogged = true;
          logInfo('embedded fallback measurer sees no keyboard — staying silent so the ' +
            'viewer keeps using its own detectors (pass geometry from the top-level page to fix this properly)');
        }
        return;
      }
      if (g.occludedBottom > 0) everOccluded = true;
      if (!force && lastSent &&
          Math.abs(g.visibleHeight - lastSent.visibleHeight) < MIN_DELTA_PX &&
          Math.abs(g.occludedBottom - lastSent.occludedBottom) < MIN_DELTA_PX) {
        return;
      }
      lastSent = g;
      post('POPCORN_HOST_GEOMETRY', g);
    }

    function onViewportChange() { sendGeometry(false); }

    // ---- LAYOUT ------------------------------------------------------------
    // Audit our own embedding and say so in three directions: the console (the
    // integrator debugging on a device), .on('layout') (their own telemetry), and
    // DOWN to the viewer, which writes it into the session's structural log — so a
    // blurry-stream report can be attributed from the pod side alone, without
    // asking the user to open devtools on their phone. Codes only.
    //
    // Every hop audits ITSELF: the chain is only as sharp as its worst layer, and
    // each frame is the only document that can see its own ancestors.
    var lastLayoutKey = '';
    function reportLayout(reason) {
      if (destroyed || !auditOn) return;
      var a;
      try { a = auditLayout(iframeEl); } catch (_) { return; }
      a.reason = reason;
      emit('layout', a);
      post('POPCORN_HOST_LAYOUT', { issues: a.issues, depth: a.depth, dpr: a.dpr,
        cssW: a.css.w, cssH: a.css.h, top: a.top, reason: reason });
      var key = a.issues.join(',');
      if (a.ok || key === lastLayoutKey) return;
      lastLayoutKey = key;
      logWarn('embed layout may rasterise the live view below device scale [' + key + ']. ' +
        'The viewer iframe must be a plain fixed full-viewport layer (position:fixed; inset:0; ' +
        'width:100%; height:100%; border:0), a direct child of <body>, with page chrome ' +
        'LAYERED OVER it instead of sized beside it.');
    }

    // An ancestor that resizes or animates the iframe after the stream is live is
    // the same hazard arriving late (a collapsing header, a sheet transition, a
    // layout that settles). Catch it by watching the box itself rather than trying
    // to enumerate animations.
    var resizeWatch = null;
    function watchResize(frame) {
      if (resizeWatch || destroyed || !auditOn) return;
      if (typeof global.ResizeObserver !== 'function') return;
      var base = null;
      try {
        resizeWatch = new global.ResizeObserver(function (entries) {
          if (destroyed || !entries.length) return;
          var r = entries[entries.length - 1].contentRect;
          if (!base) { base = { w: r.width, h: r.height }; return; }
          // The soft keyboard legitimately changes our height; a WIDTH change, or a
          // height change with no keyboard, is the page moving the stream around.
          var g = measure();
          if (Math.abs(r.width - base.w) < 1 && (g.occludedBottom > 0 || Math.abs(r.height - base.h) < 1)) return;
          base = { w: r.width, h: r.height };
          emit('layout', { ok: false, issues: ['resized'], reason: 'resize',
            css: { w: Math.round(r.width), h: Math.round(r.height) }, depth: 0,
            dpr: global.devicePixelRatio || 1, top: false });
          post('POPCORN_HOST_LAYOUT', { issues: ['resized'], cssW: Math.round(r.width),
            cssH: Math.round(r.height), reason: 'resize' });
          logWarn('the live-view iframe was resized after the stream went live — an ancestor is ' +
            'laying it out (flex/grid sibling, collapsing chrome, animation). Overlay chrome instead.');
        });
        resizeWatch.observe(iframeEl);
      } catch (_) { resizeWatch = null; }
      if (frame) { /* frame dims are the viewer's business; we only watch our box */ }
    }

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
            stopHelloRetry();
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
            reportLayout('hello');
            break;
          // The preflight ran; the full viewer handshake may still fail.
          case 'POPCORN_BOOT': emit('boot', d); break;
          case 'POPCORN_BOOT_ERROR': emit('booterror', d); break;
          case 'POPCORN_VIEWPORT': emit('viewport', d); break;
          case 'POPCORN_CONNECT': emit('connect', d); break;
          case 'POPCORN_FRAME':
            emit('frame', d);
            // Re-audit once real pixels exist: a loading cover, a skeleton, or an
            // entry animation can have been the thing holding the layer at the
            // wrong raster scale, and it is gone by now.
            reportLayout('frame');
            watchResize(d);
            break;
          case 'POPCORN_DISCONNECT': emit('disconnect', d); break;
          case 'POPCORN_ERROR': emit('error', d); break;
          case 'POPCORN_KBD_STATE': emit('kbdstate', d); break;
          case 'POPCORN_INPUT_DRIFT': emit('inputdrift', d); break;
          case 'POPCORN_INTERACTION': emit('interaction', d); break;
          case 'POPCORN_RTT': emit('rtt', d); break;
          case 'POPCORN_KBD_HEALTH': emit('health', d); break;
          // Framebuffer vs CSS vs device-pixel geometry (viewer.js traceScale).
          // The one place a "the stream looks blurry" report becomes a number, and
          // the viewer is the only side that can measure it — so a host that
          // records nothing else should record this.
          case 'POPCORN_SCALE': emit('scale', d); break;
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

      // LEGACY BRIDGE. An integrator's top-level page can measure the viewport
      // perfectly and post it under its own message shape — `{type:'parent-viewport',
      // innerHeight, viewportHeight, offsetTop}` is the one the deployed portal
      // sends. Nothing in this chain consumed it, so the geometry died at this hop
      // and the viewer fell back to a blind fallback measurer: no lift, keyboard
      // over the field, typing that looks dead (see sendGeometry above).
      //
      // Translating it here fixes that portal WITHOUT the portal changing anything,
      // which matters because the two sides ship separately. It is a pure rename —
      // the numbers are the integrator's own, and they came from window.parent like
      // every other inbound message. Opt out with { legacyGeometry: false } if a page
      // uses that message type for something else of its own.
      if (legacyGeometry && d.type === 'parent-viewport') {
        var innerH = Number(d.innerHeight);
        var visH = Number(d.viewportHeight);
        if (isFinite(innerH) && innerH > 0 && isFinite(visH) && visH > 0) {
          // offsetTop is scroll position, not keyboard occlusion.  This mirrors
          // measure() above for the legacy portal message shape.
          if (!legacyBaselineHeight || innerH > legacyBaselineHeight) legacyBaselineHeight = innerH;
          if (!legacyOccluding && Math.abs(innerH - visH) < 50) legacyBaselineHeight = innerH;
          var occ = Math.max(0, Math.max(legacyBaselineHeight, innerH) - visH);
          // Same sub-threshold rule as measure(): under ~50px is a collapsing URL
          // bar or rounding, not a keyboard.
          if (occ < 50) {
            occ = 0;
            visH = innerH;
            legacyOccluding = false;
            if (Math.abs(innerH - Number(d.viewportHeight)) < 50) legacyBaselineHeight = innerH;
          } else {
            legacyOccluding = true;
          }
          if (!legacyLogged) {
            legacyLogged = true;
            logInfo('translating the legacy parent-viewport message into POPCORN_HOST_GEOMETRY');
          }
          if (!upstreamSeen) {
            upstreamSeen = true;
            if (graceTimer) { global.clearTimeout(graceTimer); graceTimer = null; }
            if (!relay) { stopMeasuring(); relay = true; logInfo('upstream host is measuring (legacy bridge) — switching to relay'); }
          }
          pinFrameForKeyboard(occ > 0);
          post('POPCORN_HOST_GEOMETRY', annotateGeometry({ visibleHeight: visH, occludedBottom: occ }));
        }
        return;
      }
        if (d.type === 'POPCORN_HOST_GEOMETRY' || d.type === 'POPCORN_TOGGLE_MAGNIFY' ||
          d.type === 'POPCORN_TOGGLE_KBD' || d.type === 'POPCORN_PASTE' ||
          d.type === 'POPCORN_HOST_LAYOUT') {
        if (d.type === 'POPCORN_HOST_GEOMETRY' && !upstreamSeen) {
          upstreamSeen = true;
          if (graceTimer) { global.clearTimeout(graceTimer); graceTimer = null; }
          if (!relay) { stopMeasuring(); relay = true; logInfo('upstream host is measuring — switching to relay'); }
        }
        if (d.type === 'POPCORN_HOST_GEOMETRY') {
          pinFrameForKeyboard(Number(d.occludedBottom) > 0);
        }
        post(d.type, d);
      }
    }

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
    // Ask even if the frame is already cached/loaded.  A fresh navigation resets
    // its hello state, so start a new bounded handshake from the iframe load too.
    if (iframeEl && typeof iframeEl.addEventListener === 'function') {
      onFrameLoad = function () { childHello = null; beginHelloHandshake(); };
      iframeEl.addEventListener('load', onFrameLoad);
    }
    beginHelloHandshake();
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
      /** Subscribe to viewer events: boot|booterror|hello|viewport|connect|frame|disconnect|error|kbdstate|inputdrift|interaction|health|scale|layout|rtt */
      on: function (name, fn) {
        (listeners[name] || (listeners[name] = [])).push(fn);
        return this;
      },
      /** Force a geometry re-send (e.g. after your own layout change). */
      syncGeometry: function () { sendGeometry(true); },
      /**
       * Re-check the embedding against the layout contract and return the result.
       * Also emitted as .on('layout') and forwarded to the viewer's session log.
       */
      auditLayout: function () { var a = auditLayout(iframeEl); reportLayout('manual'); return a; },
      /** Drive the viewer's magnify/fit toggle from your own button. */
      toggleMagnify: function () { post('POPCORN_TOGGLE_MAGNIFY', null); },
      /** Drive the viewer's keyboard toggle from your own button. */
      toggleKeyboard: function () { post('POPCORN_TOGGLE_KBD', null); },
      /**
       * Ask for the viewer's measured tunnel round trip; the answer arrives as
       * .on('rtt', ({rttMs, avgMs, samples}) => ...). rttMs is the latest
       * viewer<->pod sample (null before the first pong), avgMs the smoothed
       * link latency. A postMessage ping from this page could only time the
       * in-device hop, so the viewer's own measurement is the one that matters.
       */
      requestRtt: function () { post('POPCORN_RTT_REQUEST', null); },
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
        if (onFrameLoad && iframeEl && typeof iframeEl.removeEventListener === 'function') {
          iframeEl.removeEventListener('load', onFrameLoad);
        }
        stopHelloRetry();
        if (graceTimer) { global.clearTimeout(graceTimer); graceTimer = null; }
        stopMeasuring();
        pinFrameForKeyboard(false);
        if (resizeWatch) { try { resizeWatch.disconnect(); } catch (_) {} resizeWatch = null; }
        listeners = {};
      },
    };
  }

  global.PopcornHost = {
    attach: attach,
    PROTOCOL: PROTOCOL,
    /** Enforce the fixed full-viewport layer contract on an iframe. */
    layer: layer,
    /** Check an embedding against it; returns { ok, issues, depth, css, dpr, top }. */
    auditLayout: auditLayout,
    /** Viewer-facing query parameters that must survive every embedding hop. */
    VIEWER_PARAMS: VIEWER_PARAMS,
    /** Those of them present in `search`, as 'k=v' strings. */
    forwardParams: forwardParams,
    LAYER_CSS: LAYER_CSS,
  };
})(typeof window !== 'undefined' ? window : this);
