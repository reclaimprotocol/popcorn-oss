// Popcorn Proxy Extension - Background Service Worker (MV3)
// Sets proxy only - auth handled via CDP Fetch

// ---- keep every browser window chromeless -----------------------------------
// The stream must never show Chromium's tab strip / omnibox. --kiosk boots the
// FIRST window chromeless, but that is all it guarantees: measured on this build,
// a window in windowState 'normal' shows a 35px toolbar EVEN under --kiosk, while
// 'fullscreen' (and 'maximized') show none. So the whole problem is "some window is
// in 'normal' state", and the culprit is not our proxy — the entire proxy issues
// exactly one setWindowBounds and it sets 'fullscreen'. It is Chromium itself:
// window.open() with size features (OAuth "Continue with Google", payment popups)
// opens a NORMAL, chromed popup, and the proxy's CDP fullscreening only lands after
// a round-trip — a visible flash, or a stuck toolbar if that call races or misses.
//
// Fix it at the layer with full control and no race: the extension owns window
// management via chrome.windows. onCreated fires as the window appears, so we
// fullscreen it before (or as) it paints — no CDP round-trip, nothing the page can
// beat. A focus-change re-check catches anything that flips an existing window back
// to 'normal' from a trigger we haven't enumerated. This is native browser API, so
// unlike a JS property patch it leaves no fingerprint tell.
function forceFullscreen(win) {
  try {
    if (win && win.id != null && win.state !== 'fullscreen') {
      chrome.windows.update(win.id, { state: 'fullscreen' }).catch(() => {});
    }
  } catch (_) {}
}
function fullscreenAll() {
  try { chrome.windows.getAll().then((ws) => ws.forEach(forceFullscreen)).catch(() => {}); } catch (_) {}
}
try {
  chrome.windows.onCreated.addListener(forceFullscreen);
  // A window flipped to 'normal' after creation still needs correcting; focus
  // changes are the cheap, event-driven moment to re-check without polling.
  chrome.windows.onFocusChanged.addListener((wid) => {
    if (wid === chrome.windows.WINDOW_ID_NONE) return;
    chrome.windows.get(wid).then(forceFullscreen).catch(() => {});
  });
  // The MV3 worker also wakes on startup/install — re-assert then, in case a
  // window was created while it was asleep.
  chrome.runtime.onStartup.addListener(fullscreenAll);
  fullscreenAll();
} catch (_) {}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PCN_PROXY_SET') {
    handleSetProxy(message.config)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'PCN_PROXY_CLEAR') {
    handleClearProxy()
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'PCN_PROXY_GET') {
    chrome.storage.local.get(['proxyConfig'], (result) => {
      sendResponse({ success: true, config: result.proxyConfig || null });
    });
    return true;
  }

  if (message.type === 'PCN_DIALOG_TOKEN') {
    // The dialog bridge's token, handed to us (the publisher) by the proxy on the
    // /kbd socket. Content scripts ask for it from their ISOLATED world so page
    // script can never read it — otherwise a hostile page could forge viewer
    // chrome. See dialog.go.
    //
    // The socket is otherwise opened lazily by the first focus report, so a page
    // with nothing focused would never have a token and every dialog would fall
    // back to the clipped native one. Connect on demand here; the content script
    // retries until the token lands. Also covers an MV3 worker that was torn down
    // and woken by this very message.
    if (!dialogBridgeToken) {
      try { kbdConnect(); } catch (_) {}
    }
    sendResponse({ token: dialogBridgeToken });
    return false;
  }

  if (message.type === 'PCN_KBD') {
    // sender.frameId identifies which frame this report came from (0 = top);
    // sender.tab which TAB (available without the "tabs" permission for
    // content-script messages, and its .active reflects the tab's CURRENT state).
    kbdReport(
      sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1,
      sender && typeof sender.frameId === 'number' ? sender.frameId : 0,
      !!(sender && sender.tab && sender.tab.active),
      message.state,
      // sender.url is the reporting FRAME's url and needs no "tabs" permission.
      sender && typeof sender.url === 'string' ? sender.url : '',
    );
    return false;
  }
});

// --- Soft-keyboard focus relay ---------------------------------------------
// Content scripts (all frames) report editable-focus changes here; we hold ONE
// WebSocket to the proxy's /kbd hub and forward the current state. The hub fans
// it out to every connected viewer, which raises/dismisses the mobile keyboard.
//
// Robustness on flaky mobile networks:
//   - Absolute state (not deltas): a dropped/reordered send is corrected by the
//     next focus event, and we resend the last state on every (re)connect.
//   - Auto-reconnect with capped backoff; the socket re-opens lazily whenever a
//     new signal needs sending (which also revives a torn-down MV3 worker).
//   - Keepalive ping while open keeps the MV3 service worker and NAT path alive.

// role=pub marks this as the publisher; the hub only relays focus state from
// publishers, so viewers (which connect without it) can't inject signals.
const KBD_URL = 'ws://127.0.0.1:6080/kbd?role=pub'; // 127.0.0.1 is in the proxy bypassList

// Token for the JS dialog bridge (proxy /dialog). Sent to publishers only, right
// after this socket connects. Re-sent on every reconnect, so it survives an MV3
// service-worker teardown.
let dialogBridgeToken = null;

// Field-value mirroring. content.js measures the focused field's text (it needs it
// for the trailing-space repair and the iOS mirror seed), but the WIRE state only
// carries it while a viewer has explicitly asked for mirroring — the hub pushes
// this flag when a ?mirror=1 viewer connects and clears it when the last one
// leaves. Default OFF, so the fan-out channel and the hub's resync cache normally
// carry field STRUCTURE (rects, hints, value length, trailing-space flag) and
// never the contents of a search box, an email field or a recovery answer.
// Re-taught on every (re)connect, which is what makes an MV3 worker restart safe.
let kbdMirror = false;
const KBD_PING_MS = 20000;
const KBD_BACKOFF_MIN_MS = 500;
const KBD_BACKOFF_MAX_MS = 10000;

let kbdSocket = null;
let kbdLastState = null;   // last MERGED focus-state object {editable, rect, hints, rects}
let kbdPingTimer = null;
let kbdBackoff = KBD_BACKOFF_MIN_MS;

// --- Per-frame focus aggregation -------------------------------------------
// content.js runs in EVERY frame (all_frames), and each frame reports its own
// focus/rects independently. Relaying whichever frame spoke last is wrong: an
// input-less cross-origin iframe (e.g. reCAPTCHA, ads) publishes
// {editable:false, rects:[]} and erases the main frame's real input rects, so
// the viewer's tap hit-test sees nothing and the keyboard misbehaves. Instead
// we keep the latest state PER frame and publish a merged view: the union of
// all frames' rects, and the focused field taken from whichever frame actually
// holds focus. Frames that go silent (navigated away) are expired by timestamp
// — content.js sends a periodic heartbeat so a live frame never looks stale.
//
// The map is keyed by TAB as well as frame. Keying by frameId alone let every
// tab's top frame share slot 0: with hanyang (no viewport meta) open in a
// BACKGROUND tab and Pinterest visible, the two heartbeats alternated in that
// slot every ~1.5s, so the merged stream the viewer saw flapped between two
// documents — pid changes every beat (instantly tripping fit's reload-on-resize
// latch), novp=true borrowed from the hidden tab (the visible responsive page
// got the 980px desktop fit), and editable focus flapping (the keyboard's
// grace-debounce dismiss loop). One tab was always fine; two broke everything.
//
// Only the ACTIVE tab's frames are merged. The others stay in the map (their
// heartbeats keep them fresh) so a tab SWITCH can publish the newly active
// tab's state immediately instead of waiting out a heartbeat.
const FRAME_STALE_MS = 6000;
// Ceiling on the MERGED rect list (content.js MAX_RECTS is per frame). Keeps the focus message well inside
// the hub's per-frame limit; a tap outside these falls back to the viewer's optimistic path.
const MERGED_MAX_RECTS = 120;
const kbdFrames = new Map(); // "tabId:frameId" -> { tabId, state, ts }

// The tab whose frames we publish. Ownership is claimed by a top-frame report
// whose document HOLDS WINDOW FOCUS (state.wf, from document.hasFocus()) —
// browser-global, so at most one tab can claim it at a time. sender.tab.active
// is NOT enough on its own: it means "active in its own window", so with two
// windows open two tabs are both "active" and alternate in the published stream
// (measured: pids lhcvtc/dlvtio flapping every heartbeat). tab.active only
// SEEDS the choice before any focus claim arrives (focus can sit in browser
// chrome at startup, where no document has it). Survives MV3 worker restarts:
// the first claiming report after a wake re-teaches it. -1 = not yet known.
let kbdActiveTab = -1;

function kbdReport(tabId, frameId, tabActive, state, senderUrl) {
  if (!state || typeof state.editable !== 'boolean') return;
  kbdFrames.set(tabId + ':' + frameId, { tabId, state, ts: Date.now() });
  if (frameId === 0 && state.wf === true) {
    kbdActiveTab = tabId; // this document's window holds focus — it owns the stream
    // document.hasFocus() on a TOP frame is browser-global, so this is the one
    // document the user is actually looking at — including when that is a popup
    // window rather than the page that opened it. The proxy has no equivalent
    // signal (CDP reports targets, not focus) and needs it to decide WHICH window
    // its close affordance should close. See kbdSendForeground.
    kbdSendForeground(senderUrl);
  } else if (kbdActiveTab === -1 && tabActive) {
    kbdActiveTab = tabId; // no focus claim yet (browser chrome holds it) — seed
  }
  if (tabId !== kbdActiveTab) return; // background tab: kept fresh in the map, never published
  kbdSend(mergeFrames());
}

// The focused top document's URL, sent to the proxy on change. Deliberately NOT
// part of the focus state: that state is fanned out to every viewer, and a URL
// routinely carries tokens in its query string. This is a publisher->server
// control frame, which the hub consumes and never relays (see keyboard.go).
let kbdForegroundUrl = null;

function kbdSendForeground(url) {
  if (typeof url !== 'string' || !url) return;
  if (url === kbdForegroundUrl) return;
  kbdForegroundUrl = url;
  kbdConnect();
  if (kbdSocket && kbdSocket.readyState === WebSocket.OPEN) {
    try { kbdSocket.send(JSON.stringify({ foreground: url })); } catch (_) {}
  }
}

// Without this listener a tab switch is only noticed when the new tab next
// REPORTS (its heartbeat carries active:true) — up to ~1.5s of the old tab's
// focus state lingering on the viewer. On activation, flip immediately and
// publish the new tab's last-known state from the map (background heartbeats
// kept it fresh); the tab's own next report refines it. onActivated needs no
// "tabs" permission — it only hands us the tabId.
try {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    kbdActiveTab = tabId;
    kbdSend(mergeFrames());
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const key of kbdFrames.keys()) {
      if (kbdFrames.get(key).tabId === tabId) kbdFrames.delete(key);
    }
    if (tabId === kbdActiveTab) kbdActiveTab = -1; // next active report re-teaches it
  });
} catch (_) {}

function mergeFrames() {
  const now = Date.now();
  let editable = false, rect = null, hints = null, sync = null, focusKey = null;
  let vw = 0, vh = 0, sw = 0, pid = null, novp = false, ol = 0, olw = 0, xf = null;
  const rects = [];
  let rtrunc = false; // merged list hit MERGED_MAX_RECTS -> the viewer must not read a miss as off-field
  for (const [key, entry] of kbdFrames) {
    if (now - entry.ts > FRAME_STALE_MS) { kbdFrames.delete(key); continue; }
    if (entry.tabId !== kbdActiveTab) continue; // background tabs are kept fresh, never published
    const frameId = Number(key.slice(key.indexOf(':') + 1));
    const s = entry.state;
    // content.js caps rects PER FRAME, so a page full of same-origin iframes multiplies that cap. Bound the
    // merged list too, or the focus message outgrows the hub's frame limit and the whole state is dropped.
    if (Array.isArray(s.rects)) {
      for (const r of s.rects) {
        if (rects.length >= MERGED_MAX_RECTS) { rtrunc = true; break; }
        rects.push(r);
      }
    }
    // The focused field comes from the one frame reporting editable:true. Only
    // the frame containing the focused element reports true (others see their
    // body/iframe as activeElement), so first-wins is safe.
    if (s.editable && !editable) {
      editable = true; rect = s.rect || null; hints = s.hints || null;
      sync = s.sync || null; focusKey = s.focusKey || null;
    }
    // Top frame owns the authoritative viewport size; fall back to any frame.
    if (frameId === 0 && s.vw > 0 && s.vh > 0) { vw = s.vw; vh = s.vh; }
    if ((!vw || !vh) && s.vw > 0 && s.vh > 0) { vw = s.vw; vh = s.vh; }
    // sw (content width, fit-to-width) and pid (page id, nav reset) come from the
    // top frame only (content.js sets them for IS_TOP). Forward them so the viewer
    // can detect a non-responsive page — the merge previously dropped these.
    if (frameId === 0) {
      if (typeof s.sw === 'number' && s.sw > 0) sw = s.sw;
      if (typeof s.pid === 'string') pid = s.pid;
      if (typeof s.novp === 'boolean') novp = s.novp; // no-viewport-meta → desktop-fallback fit
      // ol: left-overflow px (content.js leftOverflow) — content sw cannot see.
      // This merge is a WHITELIST, so a field the content script adds is DROPPED
      // unless it is named here. That is how an earlier version of this signal
      // silently never reached the viewer while looking fully deployed.
      if (typeof s.ol === 'number') ol = s.ol;
      // olw: width of the widest CLIPPED piece of real content (content.js
      // leftOverflowStats). This is the number the viewer fits to — ol says how far
      // content hangs off, olw says how wide the thing hanging off is, and only the
      // latter converges. Whitelisted here for the reason above: without this line
      // the measurement is computed, sent, and thrown away one hop short.
      if (typeof s.olw === 'number') olw = s.olw;
      // xf: cross-origin iframe rects (content.js crossOriginFrameRects) — the
      // viewer adds a compat mouse click for taps inside these. Whitelisted here
      // like every other top-frame field, or the merge would silently drop it.
      if (Array.isArray(s.xf)) xf = s.xf;
    }
  }
  const merged = { editable, rects, vw, vh };
  if (rtrunc) merged.rtrunc = true; // whitelist field, like every other one below
  if (sw > 0) merged.sw = sw;
  if (pid) merged.pid = pid;
  if (novp) merged.novp = true;
  if (ol > 0) merged.ol = ol;
  if (olw > 0) merged.olw = olw;
  if (xf && xf.length) merged.xf = xf;
  if (editable) { merged.rect = rect; merged.hints = hints; merged.sync = sync; merged.focusKey = focusKey; }
  return merged;
}

function kbdClearPing() {
  if (kbdPingTimer) {
    clearInterval(kbdPingTimer);
    kbdPingTimer = null;
  }
}

function kbdConnect() {
  if (kbdSocket &&
      (kbdSocket.readyState === WebSocket.OPEN ||
       kbdSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  let sock;
  try {
    sock = new WebSocket(KBD_URL);
  } catch (_) {
    return; // a scheduled reconnect (or the next signal) will retry
  }
  kbdSocket = sock;

  sock.onopen = () => {
    kbdBackoff = KBD_BACKOFF_MIN_MS;
    kbdClearPing();
    kbdPingTimer = setInterval(() => {
      // Heartbeat = idempotent resend of the current state. This keeps the
      // socket active (so the ephemeral MV3 worker isn't killed) without
      // introducing a message type the hub would blindly rebroadcast; viewers
      // dedupe an unchanged state to a no-op.
      try {
        if (sock.readyState === WebSocket.OPEN && kbdLastState !== null) {
          sock.send(kbdWire(kbdLastState));
        }
      } catch (_) {}
    }, KBD_PING_MS);
    // Resync current focus state to the freshly (re)connected hub.
    if (kbdLastState !== null) {
      try { sock.send(kbdWire(kbdLastState)); } catch (_) {}
    }
    // And which window is in front: the proxy drops this with the connection, and
    // an MV3 worker restart must not leave it guessing.
    if (kbdForegroundUrl) {
      try { sock.send(JSON.stringify({ foreground: kbdForegroundUrl })); } catch (_) {}
    }
  };

  const onDown = () => {
    // error+close both fire on a failed socket — run once, or we'd spawn
    // duplicate reconnect timers (and duplicate sockets).
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    // If a newer socket already superseded this one (CLOSING-state race), let
    // it own the ping timer and reconnect — this stale one just detaches.
    if (kbdSocket !== sock) return;
    kbdClearPing();
    kbdSocket = null;
    // Reconnect so a resync (and future signals) get through. Backoff caps to
    // avoid hammering a proxy that isn't up yet.
    setTimeout(kbdConnect, kbdBackoff);
    kbdBackoff = Math.min(kbdBackoff * 2, KBD_BACKOFF_MAX_MS);
  };
  sock.onclose = onDown;
  sock.onerror = onDown;

  // Viewers are the only consumers; the extension ignores anything inbound.
  // The hub is a fan-out for viewers, so the publisher receives only the two
  // control messages addressed to it: the dialog-bridge token and the mirror flag.
  sock.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg && typeof msg.bridgeToken === 'string') dialogBridgeToken = msg.bridgeToken;
      if (msg && typeof msg.mirror === 'boolean' && msg.mirror !== kbdMirror) {
        kbdMirror = msg.mirror;
        // Republish immediately: turning mirroring ON has to deliver the focused
        // field's text now (the viewer seeds its proxy input from it on the next
        // raise), and turning it OFF has to overwrite the last state the hub
        // cached for late joiners.
        if (kbdLastState !== null && sock.readyState === WebSocket.OPEN) {
          try { sock.send(kbdWire(kbdLastState)); } catch (_) {}
        }
      }
    } catch (_) {}
  };
}

// The hub rejects a frame over kbdMaxPayload (32 KiB) — and it rejects the WHOLE
// frame, so an oversized state doesn't degrade, it disappears: the viewer keeps
// stale focus geometry and taps land on the wrong fields with nothing in any log to
// say why. The per-frame rect caps don't bound this, because the merge unions every
// frame's rects, so the budget has to be enforced here, on the merged result.
// Measured in UTF-8 bytes (the wire unit): a CJK placeholder is 3 bytes per char
// where String.length counts 1. Sized well under the hub's limit so the envelope
// and any future field still fit.
const MERGED_MAX_BYTES = 24000;

function wireBytes(s) {
  try { return new TextEncoder().encode(s).length; } catch (_) { return s.length * 3; }
}

// kbdWire serializes a focus state for the wire. Two jobs: drop the field's text
// unless a viewer asked for mirroring (see kbdMirror), and keep the result inside
// the hub's frame limit. The structural signals — sync.len and sync.tail, which the
// drift detection and trailing-space repair run on — are never dropped, so the
// keyboard behaves the same either way.
function kbdWire(state) {
  let out = state;
  if (!kbdMirror && state && state.sync && typeof state.sync.val === 'string') {
    const sync = Object.assign({}, state.sync);
    delete sync.val;
    out = Object.assign({}, state, { sync });
  }
  let s = JSON.stringify(out);
  if (wireBytes(s) <= MERGED_MAX_BYTES) return s;

  // Over budget. Shed in order of what the viewer can most afford to lose.
  out = Object.assign({}, out);
  // 1. Rects are a tap hit-test OPTIMIZATION with a documented fallback (the
  //    viewer's optimistic raise), so halve them until it fits. rtrunc tells the
  //    viewer a miss must not be read as "not a field".
  if (Array.isArray(out.rects)) {
    while (out.rects.length > 0 && wireBytes(s) > MERGED_MAX_BYTES) {
      out.rects = out.rects.slice(0, Math.floor(out.rects.length / 2));
      out.rtrunc = true;
      s = JSON.stringify(out);
    }
  }
  // 2. Then the mirror seed text. DROPPED, never truncated: the viewer diffs edits
  //    against this value, and a silently shortened one would desync every keystroke.
  //    Without it mirroring just doesn't seed, and the next report can seed again.
  if (wireBytes(s) > MERGED_MAX_BYTES && out.sync && typeof out.sync.val === 'string') {
    const sync = Object.assign({}, out.sync);
    delete sync.val;
    out.sync = sync;
    s = JSON.stringify(out);
  }
  // 3. Still over: the remaining bulk is page-controlled hint strings on the focused
  //    field. Losing the state entirely is worse than losing the hints, so send the
  //    field without them rather than let the hub drop the frame.
  if (wireBytes(s) > MERGED_MAX_BYTES && out.hints) {
    out.hints = { type: out.hints.type, tag: out.hints.tag };
    out.xf = undefined;
    s = JSON.stringify(out);
  }
  return s;
}

function kbdSend(state) {
  if (!state || typeof state.editable !== 'boolean') return;
  // Cached UNREDACTED: a mirror flip republishes from here, and the redaction is
  // applied at every send (kbdWire) rather than baked into the cache.
  kbdLastState = state;
  kbdConnect();
  if (kbdSocket && kbdSocket.readyState === WebSocket.OPEN) {
    try {
      kbdSocket.send(kbdWire(state));
    } catch (_) {
      // Delivery failed mid-flight; onopen resync will resend kbdLastState.
    }
  }
  // If not yet OPEN, onopen resends kbdLastState — no explicit queue needed.
}

async function handleSetProxy(config) {
  if (!config || !config.host) {
    throw new Error('Proxy host is required');
  }

  const { host, port = 8080, scheme = 'http', bypassList = ['localhost', '127.0.0.1'] } = config;

  await chrome.proxy.settings.set({
    value: {
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme, host, port },
        bypassList
      }
    },
    scope: 'regular'
  });

  const proxyConfig = { host, port, scheme, bypassList };
  await chrome.storage.local.set({ proxyConfig });

  return { configured: true, host, port, scheme };
}

async function handleClearProxy() {
  await chrome.proxy.settings.set({
    value: { mode: 'direct' },
    scope: 'regular'
  });
  await chrome.storage.local.remove(['proxyConfig']);
  return { cleared: true };
}

// Restore on startup
chrome.storage.local.get(['proxyConfig'], (result) => {
  if (result.proxyConfig) {
    const { scheme, host, port, bypassList } = result.proxyConfig;
    chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme, host, port },
          bypassList: bypassList || ['localhost', '127.0.0.1']
        }
      },
      scope: 'regular'
    });
  }
});
