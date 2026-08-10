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
import './kbd-autofocus.js';          // side-effect: defines window.PopcornKbd
import { dbg } from './kbd/diag.js';  // boot marks — same (bundled) diag instance as kbd, one /klog sid
import { postToHost, sayHello } from './kbd/host-bridge.js';

const params = new URLSearchParams(window.location.search);
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const resize = params.get('resize') || 'scale';
const password = params.get('password') || '';
const reconnect = params.get('reconnect') !== '0';
const reconnectDelay = Number(params.get('reconnect_delay') || 600);
const magnify = params.get('magnify') === '1' || params.get('magnify') === 'true';
const screen = document.getElementById('screen');
// In magnify mode we own touch; the class enables touch-action:none (see CSS).
if (magnify) screen.classList.add('magnify');
dbg('boot mod-ready magnify=' + (magnify ? 1 : 0));

// Cold-start timing: mark milestones so the tunnel-load split (handshake ->
// first pixels -> resize -> reveal) is readable from the server /klog, no
// on-device capture. Reads a few canvas pixels every 100ms until real content
// replaces the #111 background; self-terminates at 20s.
let firstPaintMarked = false;
function markFirstPaint() {
  if (firstPaintMarked) return;
  const t0 = performance.now();
  const poll = () => {
    if (firstPaintMarked) return;
    const canvas = screen.querySelector('canvas');
    if (canvas && canvas.width > 0) {
      try {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const pts = [[w >> 1, h >> 1], [w >> 2, h >> 2], [Math.min(5, w - 1), Math.min(5, h - 1)]];
        for (const [x, y] of pts) {
          const d = ctx.getImageData(x, y, 1, 1).data; // #111 == (17,17,17)
          if (Math.abs(d[0] - 17) > 8 || Math.abs(d[1] - 17) > 8 || Math.abs(d[2] - 17) > 8) {
            firstPaintMarked = true; dbg('boot first-paint fb=' + w + 'x' + h);
            // An embedder gates its "stream is live" UI on real pixels, not on the
            // handshake — a connected-but-blank canvas must stay behind its loading
            // cover. This is the same signal the standalone page reveals on.
            postToHost('POPCORN_FRAME', { width: w, height: h });
            return;
          }
        }
      } catch (_) { firstPaintMarked = true; dbg('boot first-paint unavailable'); return; }
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

// Show the "can't reach the session" overlay. Idempotent (the overlay reuses
// one node) and only ever fired before the first successful handshake, so a
// normal mid-session reconnect never triggers it.
function showUnreachable() {
  // Surface it to an embedder too: it owns the page-level failure UX (retry,
  // analytics, session abort) and can't see our in-frame overlay.
  postToHost('POPCORN_ERROR', { reason: 'unreachable' });
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

function connect() {
  dbg('boot connect-call ever=' + (everConnected ? 1 : 0));
  intentionalDisconnect = false;
  connecting = true;
  connected = false;
  connectStartedAt = performance.now();
  rfb = new RFB(screen, `${protocol}//${window.location.host}${websocketPath()}`, {
    credentials: { password },
  });
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
    dbg('boot rfb-connect');
    postToHost('POPCORN_CONNECT', {});
    markFirstPaint(); // time the first framebuffer transfer over the tunnel
    connecting = false;
    connected = true;
    everConnected = true;
    failedConnects = 0;
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
  // 6, not 9, because of where TigerVNC's Tight encoder actually spends the bytes:
  // its quality level selects BOTH a JPEG quality and a chroma subsampling factor,
  // and 6 is the lowest level that still sends full-resolution chroma (levels 3-5
  // halve it, 0-2 quarter it). So 6 buys the whole of the visible win — correct
  // colour and no chroma bleed on coloured text — while 7-9 only raise DCT
  // precision, which costs real bytes for a difference you cannot see on a phone.
  // 9 was measured against a LAN; on the ~3 Mbps WAN path this actually ships on,
  // those extra bytes come straight out of the frame rate.
  //
  // Known limitation: latency is a proxy for bandwidth. A low-RTT but thin link
  // (good ping, little throughput) won't trip the adaptive gate, so it pays the
  // full-quality byte cost on big repaints. ?quality= overrides per-session.
  rfb.qualityLevel = Number(params.get('quality') ?? 6);
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
    // willReconnect lets the host distinguish a recoverable blip (show its
    // reconnecting overlay, keep the session) from a real teardown.
    postToHost('POPCORN_DISCONNECT', { willReconnect, everConnected });
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
function reconnectNow() {
  if (window.__viewerUnsupported) return; // proactively blocked; WS can't work here
  if (intentionalDisconnect || connected) return;
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
window.addEventListener('pageshow', reconnectNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });

window.addEventListener('beforeunload', () => {
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
sayHello({
  magnify,
  vk: !!navigator.virtualKeyboard,
  vv: !!window.visualViewport,
  unsupported: window.__viewerUnsupported || null,
});

// Skip the doomed connect loop when the pre-flight gate already blocked this
// environment (Opera Mini / too-old browser) — the overlay is already shown.
if (!window.__viewerUnsupported) connect();
