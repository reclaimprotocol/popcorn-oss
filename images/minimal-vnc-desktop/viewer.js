// viewer.js — the liveview page controller, bundled (with noVNC core + the kbd/
// IME layer) into a single viewer.bundle.js by esbuild at image-build time.
//
// Why a bundle: the viewer's JS is a ~70-module ES graph (noVNC core/* +
// kbd/*). Shipped raw, the browser discovers modules level-by-level over the
// tunnel — several serial round-trips before anything runs (~3.7s was measured
// on 3G). Bundling collapses that to ONE request. Because everything is in one
// file, PopcornKbd is defined synchronously when this runs, so there is no
// module-load / handshake overlap to orchestrate (and no attach race): dial and
// attach happen together once the single bundle has loaded.
//
// Source stays modular (this file + kbd/*.js + core/*.js); esbuild is the only
// thing that sees the graph. Edit the modules; the build re-bundles.

import RFB from './core/rfb.js';
import { createEmbeddedLiveViewE2EClient } from './e2e/bootstrap.js';
import './kbd-autofocus.js';          // side-effect: defines window.PopcornKbd
import { dbg, KBD_LOG, KBD_SID } from './kbd/diag.js';  // boot marks — same (bundled) diag instance as kbd, one /klog sid
import { onLifecycleAck, postToHost, sayHello } from './kbd/host-bridge.js';
import { fbTarget, FB_MAX } from './kbd/fbtarget.js';
import { configureEncryptedControl, encryptedTransportRequested, viewerFetch } from './kbd/liveview-transport.js';

const params = new URLSearchParams(window.location.search);
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const resize = params.get('resize') || 'scale';
const password = params.get('password') || '';
const reconnect = params.get('reconnect') !== '0';
const reconnectDelay = Number(params.get('reconnect_delay') || 600);
const magnify = params.get('magnify') === '1' || params.get('magnify') === 'true';
const encryptedMode = encryptedTransportRequested();
let encryptedClientPromise = null;

function encryptedClient() {
  if (!encryptedMode) return Promise.resolve(null);
  if (encryptedClientPromise) return encryptedClientPromise;
  encryptedClientPromise = Promise.resolve().then(() => {
    const bootstrap = window.__POPCORN_LIVEVIEW_E2E_BOOTSTRAP__;
    return typeof bootstrap === 'function'
      ? bootstrap()
      : createEmbeddedLiveViewE2EClient(window);
  }).then((client) => {
    if (!client || typeof client.connectRfb !== 'function' || typeof client.connectControl !== 'function') {
      throw new TypeError('invalid LiveView E2E client');
    }
    return client;
  });
  return encryptedClientPromise;
}
// Framebuffer size cap (see rfb._screenSize below), in priority order:
// ?fbcap=WxH pins it, else the server's /geometry, else the boot framebuffer at
// the first handshake. Read by both rfb._screenSize (the resize request) and
// kbd/fit.js computeEmulation (the CDP layout size) so the two never disagree.
window.__pcnFbCap = null;
let fbCapPinned = false;
const fbcapParam = params.get('fbcap');
if (fbcapParam && /^\d+x\d+$/.test(fbcapParam)) {
  const [cw, ch] = fbcapParam.split('x').map(Number);
  if (cw > 0 && ch > 0) { window.__pcnFbCap = { w: cw, h: ch }; fbCapPinned = true; }
}
// /geometry beats the connect-time framebuffer because the latter lies on a
// reused container: a prior phone-sized session leaves the X screen
// sticky-small, and a desktop viewer would latch that as its cap and render a
// narrow strip. Fails open on an older proxy without the route.
if (!fbCapPinned) {
  const geomURL = window.location.pathname.replace(/\/[^/]*$/, '/geometry');
  viewerFetch(geomURL, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((g) => {
      if (g && g.width > 0 && g.height > 0 && !fbCapPinned) {
        window.__pcnFbCap = { w: g.width, h: g.height };
        dbg('boot fbcap(geometry)=' + g.width + 'x' + g.height);
      }
    })
    .catch(() => {});
}
// Keep in sync with env.js FILL.
window.__pcnFill = magnify && params.get('fill') !== '0';
// The framebuffer + CDP-emulate target size for a desired viewport, the single
// source of truth for both rfb._screenSize and kbd/fit.js computeEmulation:
//   default: clamp each axis at the cap independently — the remote renders at
//     the cap's own aspect and the viewer centers it 1:1, letterboxing a bigger
//     window.
//   fill: clamp proportionally to the WINDOW's aspect, so the page renders at
//     the window's shape (nothing cropped) and the viewer upscales it to fill,
//     trading sharpness for the letterbox.
//
// SUPERSAMPLING (kbd/fbscale.js): the returned framebuffer is the CSS target times
// the active scale factor, while cssW/cssH stay the CSS-pixel LAYOUT size. Both
// consumers read the half they need from one place, which is what keeps the CDP
// render and the VNC framebuffer the same size — the invariant that a mismatched
// deviceScaleFactor breaks (it crops). The cap applies to the CSS size (it is about
// sane LAYOUT sizes, and the kiosk window is fitted to whatever screen we ask for);
// FB_MAX bounds the product.
window.__pcnFbScale = 1;
window.__pcnFbTarget = (w, h) => fbTarget(w, h, window);
const screen = document.getElementById('screen');

// noVNC converts browser events to canvas-local coordinates before calling these
// private methods. A CSS fill transform makes those coordinates visual pixels,
// while Display.absX/absY expects layout pixels. Correct at that boundary rather
// than relying on DOM propagation, which differs across desktop browsers.
function installPointerTransformFix(instance) {
  const map = (x, y) => {
    if (instance.__pcnPointerCoordsAreLayout) return [x, y];
    const canvas = screen && screen.querySelector('canvas');
    if (!canvas) return [x, y];
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return [x, y];
    const sx = canvas.clientWidth > 0 ? canvas.clientWidth / rect.width : 1;
    const sy = canvas.clientHeight > 0 ? canvas.clientHeight / rect.height : 1;
    return [x * sx, y * sy];
  };
  for (const name of ['_handleMouseButton', '_handleMouseMove']) {
    const original = instance[name];
    if (typeof original !== 'function') continue;
    instance[name] = function (x, y, ...rest) {
      [x, y] = map(x, y);
      return original.call(this, x, y, ...rest);
    };
  }
}
// In magnify mode we own touch; the class enables touch-action:none (see CSS).
if (magnify) screen.classList.add('magnify');
dbg('boot mod-ready magnify=' + (magnify ? 1 : 0));

// The sharpness numbers, in one line.
//
// "The remote UI looks blurry" has three independent causes and they are only
// separable numerically, so report all four quantities rather than a verdict:
//
//   fb    framebuffer size — remote pixels we are actually being sent
//   css   the canvas box on this device, in CSS px
//   sc    fb/css: remote pixels per CSS pixel. 1.00 = 1:1, <1 = we are upscaling
//         the stream (soft by construction), >1 = supersampled (sharp)
//   dev   sc/devicePixelRatio: remote pixels per DEVICE pixel, the number that
//         predicts what the user sees. On a 3x phone streaming a CSS-px-sized
//         framebuffer this is ~0.33, and no encoder setting can fix that — it is
//         the deviceScaleFactor:1 trade in kbd/fit.js. Anything BELOW that ratio
//         means something above us (a compositor rasterising the iframe's layer
//         small — see host/popcorn-host.js auditLayout) is losing detail we did
//         pay to send.
//
// Structural only: sizes and ratios, nothing about what is on the screen.
let lastScaleKey = '';
function traceScale(reason) {
  const canvas = screen && screen.querySelector('canvas');
  if (!canvas || !canvas.width) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  const fbScale = window.__pcnFbScale || 1;
  const sc = canvas.width / r.width;
  const dev = sc / dpr;
  const key = canvas.width + 'x' + canvas.height + '|' + Math.round(r.width) + 'x' + Math.round(r.height) + '|' + dpr.toFixed(2) + '|' + fbScale;
  if (key === lastScaleKey) return; // only on a real change, not per resize event
  lastScaleKey = key;
  dbg('scale ' + reason + ' fb=' + canvas.width + 'x' + canvas.height +
    ' css=' + Math.round(r.width) + 'x' + Math.round(r.height) +
    ' dpr=' + dpr.toFixed(2) + ' sc=' + sc.toFixed(2) + ' dev=' + dev.toFixed(2) +
    ' fbscale=' + fbScale, true);
  // Up to the embedder too: it is the side that can DO something about a soft
  // stream (its own layout), and it cannot see any of these numbers itself.
  postToHost('POPCORN_SCALE', {
    fbWidth: canvas.width, fbHeight: canvas.height,
    cssWidth: Math.round(r.width), cssHeight: Math.round(r.height),
    dpr, scale: Number(sc.toFixed(3)), deviceScale: Number(dev.toFixed(3)), fbScale, reason,
  });
}

let lastViewTrace = 0;
function traceView(reason) {
  const now = performance.now();
  if (now - lastViewTrace < 250) return;
  lastViewTrace = now;
  traceScale(reason);
  const canvas = screen && screen.querySelector('canvas');
  const vv = window.visualViewport;
  dbg('view ' + reason +
    ' win=' + window.innerWidth + 'x' + window.innerHeight +
    ' vv=' + (vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) : '-') +
    ' canvas=' + (canvas ? canvas.width + 'x' + canvas.height : '-') +
    ' connected=' + (connected ? 1 : 0));
}
window.addEventListener('resize', () => traceView('resize'));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => traceView('vv-resize'));
  window.visualViewport.addEventListener('scroll', () => traceView('vv-scroll'));
}
document.addEventListener('visibilitychange', () => traceView(document.hidden ? 'hidden' : 'visible'));

// Cold-start timing: mark milestones so the tunnel-load split (handshake ->
// first pixels -> resize -> reveal) is readable from the server /klog, no
// on-device capture. Reads a few canvas pixels every 100ms until real content
// replaces the #111 background; self-terminates at 20s.
let firstPaintConnection = 0;
function markFirstPaint(connection) {
  if (firstPaintConnection === connection) return;
  const t0 = performance.now();
  const poll = () => {
    if (firstPaintConnection === connection || connection !== rfbConnection) return;
    const canvas = screen.querySelector('canvas');
    if (canvas && canvas.width > 0) {
      try {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const pts = [[w >> 1, h >> 1], [w >> 2, h >> 2], [Math.min(5, w - 1), Math.min(5, h - 1)]];
        for (const [x, y] of pts) {
          const d = ctx.getImageData(x, y, 1, 1).data; // #111 == (17,17,17)
          if (Math.abs(d[0] - 17) > 8 || Math.abs(d[1] - 17) > 8 || Math.abs(d[2] - 17) > 8) {
            firstPaintConnection = connection;
            dbg('rfb first-frame conn=' + connection + ' wait=' + Math.round(performance.now() - t0) + 'ms fb=' + w + 'x' + h);
            // An embedder gates its "stream is live" UI on real pixels, not on the
            // handshake — a connected-but-blank canvas must stay behind its loading
            // cover. This is the same signal the standalone page reveals on.
            postLifecycle('POPCORN_FRAME', { width: w, height: h, connection });
            traceScale('first-frame');
            return;
          }
        }
      } catch (_) { firstPaintConnection = connection; dbg('rfb first-frame unavailable conn=' + connection); return; }
    }
    if (performance.now() - t0 < 20000) setTimeout(poll, 100);
  };
  poll();
}

let rfb;
let intentionalDisconnect = false;
let connecting = false;      // a connect attempt is in flight (pre-'connect')
let connected = false;       // RFB handshake completed
let reconnectTimer = null;   // pending auto-reconnect
let everConnected = false;   // handshake succeeded at least once this session
let connectWatchdog = null;  // fires if a connect stalls mid-handshake (any attempt)
let failedConnects = 0;      // consecutive failures BEFORE the first success
let connectStartedAt = 0;    // performance.now() of the in-flight connect (stall check)
let rfbConnection = 0;
let reconnectAttempt = 0;
let disconnectedAt = 0;
let lifecycleSeq = 0;

function postLifecycle(type, data) {
  const seq = ++lifecycleSeq;
  dbg('lifecycle send type=' + type + ' seq=' + seq);
  postToHost(type, Object.assign({ seq }, data || {}));
}
onLifecycleAck((seq) => dbg('lifecycle ack seq=' + seq));

// Show the "can't reach the session" overlay. Idempotent (the overlay reuses
// one node) and only ever fired before the first successful handshake, so a
// normal mid-session reconnect never triggers it.
function showUnreachable() {
  // Surface it to an embedder too: it owns the page-level failure UX (retry,
  // analytics, session abort) and can't see our in-frame overlay.
  postLifecycle('POPCORN_ERROR', { reason: 'unreachable' });
  window.__viewerOverlay?.(
    'Can’t reach the live session',
    'If you have a data-saver, Turbo, or “extreme savings” mode turned on (e.g. in Opera), turn it off — it can block the live connection. Otherwise check your network and try again.',
    reconnectNow
  );
}

// How long to wait for the first successful handshake before telling the user
// the connection is being blocked. Opera's data-saver/Turbo/extreme-savings
// modes (and other compression proxies) silently drop the WebSocket without a
// UA we can match, so we can't proactively block them — we surface it here
// instead once a connect has demonstrably failed to land. Auto-hidden the
// moment any attempt succeeds, so a slow-but-working link just shows late.
const CONNECT_TIMEOUT_MS = 12000;

function boolParam(name, fallback) {
  const value = params.get(name);
  if (value === null) return fallback;
  return value === '1' || value === 'true';
}

function websocketPath() {
  const configuredPath = params.get('path');
  if (configuredPath) {
    return configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`;
  }
  return window.location.pathname.replace(/\/[^/]*$/, '/websockify');
}

async function connect() {
  if (connecting || connected || intentionalDisconnect) return;
  if (everConnected) reconnectAttempt++;
  dbg('rfb connect-start reconnect=' + (everConnected ? 1 : 0) + ' attempt=' + reconnectAttempt);
  intentionalDisconnect = false;
  connecting = true;
  connected = false;
  connectStartedAt = performance.now();
  // ?keep=1 opts out of the proxy's first-connect screen reset: magnify resizes
  // the screen itself after the handshake, and being reset first would bounce
  // the page through a desktop-width relayout on every soft reconnect (a
  // state-losing reload on reload-on-resize sites). Plain viewers never resize,
  // so they do want the reset — it is how they get the full desktop.
  const wsPath = websocketPath();
  const wsQueryParts = [];
  if (magnify) wsQueryParts.push('keep=1');
  // Correlate opt-in browser and proxy diagnostics with a random page-load id.
  if (KBD_LOG) wsQueryParts.push(`diag_sid=${encodeURIComponent(KBD_SID)}`);
  const wsQuery = wsQueryParts.length
    ? `${wsPath.includes('?') ? '&' : '?'}${wsQueryParts.join('&')}`
    : '';
  let rfbTransport = `${protocol}//${window.location.host}${wsPath}${wsQuery}`;
  if (encryptedMode) {
    try {
      const client = await encryptedClient();
      // The control manager begins its Noise handshake immediately, in parallel
      // with the RFB channel. The same viewer state machine consumes both modes.
      const control = configureEncryptedControl(() => client.connectControl(), { mirror: params.get('mirror') === '1' });
      control.ensureConnected();
      rfbTransport = await client.connectRfb();
    } catch (error) {
      connecting = false;
      failedConnects++;
      dbg('rfb encrypted-connect failed: ' + ((error && error.message) || 'unknown'));
      if (failedConnects >= 2) showUnreachable();
      if (reconnect && !intentionalDisconnect && reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
      }
      return;
    }
  }
  if (intentionalDisconnect) return;
  rfb = new RFB(screen, rfbTransport, {
    credentials: { password },
  });
  installPointerTransformFix(rfb);
  // Bound the framebuffer size noVNC asks the X server for. _screenSize()
  // returns getBoundingClientRect(#screen) in CSS px and sends it verbatim as
  // SetDesktopSize, which browser page zoom inflates wildly — at 25% zoom a
  // 1728-px window reports 6912 CSS px and grows the X screen to 6912x3464
  // (measured). Xvnc has no MaxDesktopSize flag, so the cap lives here, on the
  // request. It is about sane render sizes, not black bands: proxy/window.go
  // re-fits the kiosk window to the screen, so an oversized screen paints.
  //
  // The cap is the boot geometry (WIDTH x FB_HEIGHT), learned rather than
  // hardcoded so a tall-boot container caps at its real size instead of 1080.
  // FB_MAX is the absolute backstop.
  //
  // NB: a CAP only — deliberately NOT `rect * devicePixelRatio`, which was
  // measured to CLIP the desktop on every retina device (a 390-CSS phone would
  // request 1170 px and be shown 1:1 in a 390 window).
  rfb._screenSize = function () {
    const r = this._screen.getBoundingClientRect();
    // Fit-to-width owns a deliberately oversized framebuffer (it grows #screen
    // to the whole page, then scaleViewport-downscales it), so bow out to the
    // FB_MAX backstop while it runs rather than truncating its dance.
    if (window.__pcnFitActive) return { w: Math.min(r.width, FB_MAX), h: Math.min(r.height, FB_MAX) };
    const t = window.__pcnFbTarget(r.width, r.height);
    return { w: Math.min(t.w, FB_MAX), h: Math.min(t.h, FB_MAX) };
  };
  // Handshake-stall watchdog, armed on EVERY connect (not just the first). A
  // reconnect that opens the socket but stalls mid-RFB-handshake — the mobile
  // app-switch case, where the OS half-kills the socket while backgrounded —
  // fires neither 'connect' nor 'disconnect', so `connecting` would wedge true
  // forever and the canvas (removed on the prior disconnect) sits on the #111
  // background = a permanent black screen with nothing to retry it. On timeout
  // with no handshake, force the connection down so the 'disconnect' handler
  // below owns the retry. Before the first success we ALSO surface the
  // blocked-WS overlay (Opera data-saver etc.); mid-session reconnects just
  // recycle silently.
  if (connectWatchdog !== null) window.clearTimeout(connectWatchdog);
  connectWatchdog = window.setTimeout(() => {
    connectWatchdog = null;
    if (connected) return; // handshake landed — nothing to do
    if (!everConnected) showUnreachable();
    dbg('boot connect-watchdog: handshake stall -> recycle');
    try { rfb && rfb.disconnect(); } catch (_) {}
  }, CONNECT_TIMEOUT_MS);
  rfb.addEventListener('connect', () => {
    // Last-resort cap source: the boot framebuffer, read once and before
    // magnify's first resizeSession changes it. Skipped once the cap is known,
    // which also means reconnects never learn from a sticky framebuffer.
    if (!window.__pcnFbCap && rfb._fbWidth > 0 && rfb._fbHeight > 0) {
      window.__pcnFbCap = { w: rfb._fbWidth, h: rfb._fbHeight };
      dbg('boot fbcap=' + rfb._fbWidth + 'x' + rfb._fbHeight);
    }
    connecting = false;
    connected = true;
    everConnected = true;
    failedConnects = 0;
    const connection = ++rfbConnection;
    const handshakeMS = Math.round(performance.now() - connectStartedAt);
    const outageMS = disconnectedAt ? Math.round(performance.now() - disconnectedAt) : 0;
    dbg('rfb connect conn=' + connection + ' handshake=' + handshakeMS + 'ms outage=' + outageMS + 'ms attempt=' + reconnectAttempt);
    postLifecycle('POPCORN_CONNECT', { connection, handshakeMs: handshakeMS, outageMs: outageMS, attempt: reconnectAttempt });
    markFirstPaint(connection); // time the first framebuffer transfer over the tunnel
    reconnectAttempt = 0;
    disconnectedAt = 0;
    if (connectWatchdog !== null) { window.clearTimeout(connectWatchdog); connectWatchdog = null; }
    window.__viewerHideOverlay?.();
    // Reveal the stream: drop the static boot/unsupported fallback now that a
    // real RFB session is up. Engines that never reach here (Opera Mini, dead
    // sandboxes) keep showing it — that's the intended "use a real browser".
    var boot = document.getElementById('boot-fallback');
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
  });
  rfb.viewOnly = boolParam('view_only', false);
  rfb.shared = boolParam('shared', true);
  // Magnify resizes the remote framebuffer to our viewport (shown 1:1) with
  // the matching CDP emulation. PopcornKbd owns the resize CADENCE (freeze
  // during a drag, resize once on settle) so a continuous resize doesn't
  // realloc the framebuffer ~10x/sec and thrash the encoder — so leave
  // resizeSession OFF here; startMagnify turns it on at the right moments.
  rfb.scaleViewport = magnify ? false : (resize === 'scale');
  rfb.resizeSession = magnify ? false : (resize === 'remote');
  rfb.showDotCursor = boolParam('show_dot', false);
  rfb.background = '#111';
  // Encoding for constrained mobile links: max zlib compression (fewer bytes, and
  // it costs remote CPU rather than bandwidth — zlib is lossless, so this never
  // affects sharpness).
  rfb.compressionLevel = Number(params.get('compression') ?? 9);
  // JPEG quality BASELINE, deliberately high. This used to be 5, which pessimised
  // every link including good ones: text is the payload here, and in magnify /
  // readable-zoom the framebuffer is magnified 2-3x on a DPR-3 phone, so JPEG
  // ringing around antialiased glyphs is magnified with it — the single most
  // visible artifact on a login form.
  //
  // A high baseline is safe because degradation is already ADAPTIVE: ./kbd/quality.js
  // drops quality to 2 while typing and while a forwarded scroll is in flight, and
  // only once linkLatency() >= 500ms. So a slow link behaves as it did before (low
  // quality exactly when bytes-per-frame gates responsiveness), while an idle or
  // fast link now renders text at close to full fidelity.
  //
  // Use the Tight encoder's highest JPEG quality by default. The viewer often
  // displays small browser text at a magnified scale, where lower DCT precision
  // is visibly soft even after chroma subsampling has been disabled. The adaptive
  // path in quality.js can still reduce quality briefly on a demonstrably slow
  // connection; ?quality= remains available for an explicit per-session override.
  rfb.qualityLevel = Number(params.get('quality') ?? 9);
  // Bind the mobile keyboard/IME layer. Synchronous: the layer is in this bundle,
  // so window.PopcornKbd is already defined — attach's 'connect' listener is
  // registered before the handshake completes (no race). attach() also sets
  // focusOnClick=false so noVNC doesn't steal focus from the proxy input on tap.
  // No-op on non-touch and when view_only.
  if (window.PopcornKbd && !rfb.viewOnly) {
    window.PopcornKbd.attach(rfb);
  }
  rfb.addEventListener('disconnect', () => {
    connecting = false;
    connected = false;
    // This attempt resolved (cleanly or not), so retire its stall watchdog; the
    // next connect() re-arms a fresh one. Left pending, it would later fire and
    // tear down the *next* attempt.
    if (connectWatchdog !== null) { window.clearTimeout(connectWatchdog); connectWatchdog = null; }
    const willReconnect = reconnect && !intentionalDisconnect;
    disconnectedAt = performance.now();
    dbg('rfb disconnect conn=' + rfbConnection + ' connected=' + (everConnected ? 1 : 0) + ' willReconnect=' + (willReconnect ? 1 : 0));
    // willReconnect lets the host distinguish a recoverable blip (show its
    // reconnecting overlay, keep the session) from a real teardown.
    postLifecycle('POPCORN_DISCONNECT', { willReconnect, everConnected, connection: rfbConnection });
    // A failure before the FIRST successful handshake is the data-saver /
    // blocked-WS signature (Opera's proxy drops the socket fast, so noVNC
    // fires disconnect almost immediately). Surface the overlay after a
    // second failure — quick, but tolerant of a single transient blip — so
    // the user isn't staring at a black screen for the full watchdog window.
    // everConnected gates this out entirely once a session has ever worked,
    // so normal mid-session reconnects never show it.
    if (!everConnected) {
      failedConnects++;
      if (failedConnects >= 2) showUnreachable();
    }
    // Soft detach on auto-reconnect keeps the soft keyboard up and replays
    // keystrokes typed during the gap; full detach only on real teardown.
    if (window.PopcornKbd) window.PopcornKbd.detach(willReconnect ? { soft: true } : undefined);
    if (willReconnect) {
      reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    }
  });
}

// Network is back / tab foregrounded: reconnect the pixel stream now instead
// of waiting out reconnectDelay. Guarded so we never stack connections.
// A socket the browser closed while we were frozen leaves noVNC believing it is still
// connected — sendKey then throws into our catch and every keystroke vanishes silently.
function rfbSocketDead() {
  try { return !!(rfb && rfb._sock && rfb._sock.readyState !== 'open'); } catch (_) { return false; }
}

function reconnectNow() {
  if (window.__viewerUnsupported) return; // proactively blocked; WS can't work here
  if (intentionalDisconnect) return;
  if (connected && rfbSocketDead()) {
    dbg('resume: rfb socket ' + (rfb && rfb._sock ? rfb._sock.readyState : '?') + ' -> recycle');
    try { rfb.disconnect(); } catch (_) {} // the disconnect handler reconnects
    return;
  }
  if (connected) return;
  if (connecting) {
    // A connect is already in flight — normally let it resolve. But a reconnect
    // that stalled while we were backgrounded can hang here mid-handshake; if
    // it's been pending a while, force it down NOW so we retry immediately
    // instead of staring at a black screen until the stall watchdog fires.
    if (performance.now() - connectStartedAt > 3000) {
      dbg('boot reconnectNow: stale in-flight connect -> recycle');
      try { rfb && rfb.disconnect(); } catch (_) {}
    }
    return;
  }
  if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
  connect();
}
window.addEventListener('online', reconnectNow);
// A restored page is not a torn-down one: clear the latch, or reconnectNow's early return
// leaves the stream dead for the rest of the session.
window.addEventListener('pageshow', () => { intentionalDisconnect = false; reconnectNow(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { intentionalDisconnect = false; reconnectNow(); }
});

// Latch on a REAL unload only: mobile engines fire beforeunload for a mere freeze (app switch,
// bfcache), and latching there killed the stream and every keystroke on return.
window.addEventListener('pagehide', (event) => {
  if (event && event.persisted) return; // frozen, not unloaded — it can come back
  intentionalDisconnect = true;
  if (rfb) rfb.disconnect();
});

// Announce ourselves to an embedder: the protocol version it's talking to, plus
// the capabilities that decide whether it must feed us geometry. vk=0 means our
// VirtualKeyboard API is absent or mute (iOS always, or a Chromium embed without
// allow="virtual-keyboard"), which is precisely when a host that CAN measure has
// to post POPCORN_HOST_GEOMETRY or the keyboard lift will be zero. Sent
// unconditionally (not just when ?parentOrigin= is set) so a host can discover a
// viewer that wasn't configured for it and log the misconfiguration loudly rather
// than silently mis-driving the keyboard.
// Cancel the ES5 boot watchdog in liveview.html. Reaching this line proves the
// whole module graph evaluated (noVNC included) — everything that kills us before
// it (blocked fetch, truncated body, uncaught throw, a renderer that stalls mid
// evaluation) is externally indistinguishable from silence, so the watchdog treats
// a still-false flag as "never booted" and reloads once.
window.__viewerBooted = true;

sayHello({
  magnify,
  vk: !!navigator.virtualKeyboard,
  vv: !!window.visualViewport,
  unsupported: window.__viewerUnsupported || null,
});

// Skip the doomed connect loop when the pre-flight gate already blocked this
// environment (Opera Mini / too-old browser) — the overlay is already shown.
if (!window.__viewerUnsupported) connect();
