// stub-dom.mjs — browser-global stub for characterization tests of the kbd layer.
//
// Installs just enough of a browser for kbd-autofocus.js (and every ./kbd/*.js
// module) to load and run its input handlers under Node's test runner. The two
// core tricks:
//   * created elements RECORD their event listeners (el._listeners), so a test
//     can fire synthetic beforeinput/input/keydown/composition* events straight
//     at the proxy element and observe the resulting keysym stream on a mock RFB;
//   * the WebSocket stub RECORDS instances, so a test drives applySignal (hints /
//     rects / sensitive / sync state) by firing `onmessage` on the captured /kbd
//     socket — the exact transport the real extension uses.
//
// IMPORTANT (process = profile): ./kbd/env.js computes isIOS/isAndroid/DESKTOP/
// MAGNIFY/etc. ONCE per process from these globals at first import. So each test
// FILE pins one profile via installGlobals(profile) before any import of the
// core, and node --test's per-file process isolation keeps profiles apart.
// Within a file, freshViewer() cache-busts ONLY the core module (child modules —
// latency, rtt, diag — stay shared; tests that mutate them, e.g. slow-link RTT
// seeding, get their own file).
//
// Timers: real setTimeout (the 90ms deferred backspace and dismiss graces depend
// on it — tests await them); setInterval is inert (watchdog / button poll / RTT
// ping / stale-watch loops never fire). The clock read by nowMs() is a
// CONTROLLABLE performance.now stub — advanceClock(ms) fakes elapsed time for
// age-based logic (send-queue staleness, rect stickiness) without real waits.

const noop = () => {};

// ---- controllable clock ----------------------------------------------------
let clockNow = 1000;
export function advanceClock(ms) { clockNow += ms; }
export function clock() { return clockNow; }

// ---- recorded element ------------------------------------------------------
export const createdElements = [];

// Real prototype so the core's `target instanceof Element` checks work.
export class StubElement {}

function makeElement(tag) {
  const el = Object.assign(Object.create(StubElement.prototype), {
    tagName: String(tag || 'div').toUpperCase(),
    value: '',
    className: '',
    id: '',
    innerHTML: '',
    textContent: '',
    isContentEditable: false,
    tabIndex: 0,
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    nextSibling: null,
    _listeners: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    removeAttribute(k) { delete this.attributes[k]; },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = this._listeners[type];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c === other || (c.contains && c.contains(other)));
    },
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    focus() { globalThis.document.activeElement = this; },
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; },
    setSelectionRange: noop,
    editContext: null,
  });
  createdElements.push(el);
  return el;
}

// Find the hidden proxy the core created in setup(). Searched from the END:
// freshViewer() cache-busts the core per test, so several proxies accumulate —
// the live one is always the most recently created.
export function findProxy() {
  for (let i = createdElements.length - 1; i >= 0; i--) {
    if (createdElements[i].className === 'mobile-proxy-input') return createdElements[i];
  }
  return null;
}

// ---- synthetic events ------------------------------------------------------
// Build an event object and invoke every recorded listener for `type` on `el`.
// Returns the event so tests can assert on defaultPrevented.
export function fire(el, type, props) {
  const e = Object.assign({
    type,
    target: el,
    defaultPrevented: false,
    cancelable: true,
    isComposing: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation: noop,
  }, props || {});
  const list = (el._listeners[type] || []).slice();
  for (const fn of list) fn(e);
  return e;
}

// ---- visualViewport / parent frame / interval instrumentation ---------------
let vvListeners = {};
export function setVisualViewportHeight(h) { globalThis.window.visualViewport.height = h; }
export function fireViewport(type) {
  for (const fn of (vvListeners[type] || []).slice()) fn({});
}
// POPCORN_VIEWPORT / POPCORN_INPUT_DRIFT messages posted to the embedding frame.
export const parentMessages = [];

// ---- window-level events -----------------------------------------------------
// Recorded by installGlobals' addEventListener. fireWindow drives them.
let winListeners = {};
export function clearWindowListeners() { winListeners = {}; }
// Returns the dispatched event object so a test can inspect what the listeners did
// TO it (capture-phase handlers that rewrite coordinates, stopPropagation flags…),
// not just what they did with it.
export function fireWindow(type, props) {
  // Same event surface as fireDoc — window-capture handlers call preventDefault
  // and stopImmediatePropagation, which a bare {type} object would throw on.
  const e = Object.assign({
    type,
    target: (props && props.target) || null,
    defaultPrevented: false,
    propagationStopped: false,
    cancelable: true,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
  }, props || {});
  for (const fn of (winListeners[type] || []).slice()) fn(e);
  return e;
}
/**
 * Deliver a host->viewer postMessage as the configured embedder would: from the
 * real parent window, with the origin the viewer was loaded with. host-bridge's
 * inbound policy checks BOTH, so a test that gets either wrong sees the message
 * silently ignored — which is the behavior we want in production and the reason
 * this helper exists instead of hand-rolling the event per test.
 */
export function fireHostMessage(data, opts) {
  const o = opts || {};
  fireWindow('message', {
    data,
    origin: o.origin || 'https://portal.test',
    source: o.source || globalThis.window.parent,
  });
}
// Registered (never self-ticking) intervals — tickIntervals() fires each once.
export const intervals = [];
export function tickIntervals() {
  for (const it of intervals.slice()) it.fn();
}

// ---- document-level events + #screen element --------------------------------
// The gesture handlers (touchstart/move/end/cancel) are registered on document
// in setup(); record them so tests can drive full gestures.
let docListeners = {};
export function fireDoc(type, props) {
  const e = Object.assign({
    type,
    target: (props && props.target) || null,
    defaultPrevented: false,
    cancelable: true,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation: noop,
    stopImmediatePropagation: noop,
  }, props || {});
  for (const fn of (docListeners[type] || []).slice()) fn(e);
  return e;
}

// The viewer's #screen element (canvas host) — installGlobals resets it; tests
// that exercise zoom/pan call makeScreen() to install one.
let screenEl = null;
export function makeScreen() {
  const canvas = makeElement('canvas');
  canvas.width = 390; canvas.height = 844;
  // clientWidth/Height are the layout (untransformed) size; getBoundingClientRect
  // reports the TRANSFORMED box. Equal here = no CSS zoom; the pointer-click path
  // divides one by the other to undo the zoom, so both must exist.
  canvas.clientWidth = 390; canvas.clientHeight = 844;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 844 });
  const screen = makeElement('div');
  screen.id = 'screen';
  screen.offsetWidth = 390; screen.offsetHeight = 844;
  screen.querySelector = (sel) => (sel === 'canvas' ? canvas : null);
  screen.appendChild(canvas);
  screenEl = screen;
  return screen;
}

// ---- ResizeObserver recorder -------------------------------------------------
// The viewer observes its display surface DIRECTLY, because in an embedded
// WebView neither window.resize nor visibilitychange is guaranteed to fire when
// the host changes the iframe's size. Tests drive that edge through
// fireResizeObservers(el), which is the same notification the browser delivers.
export const resizeObservers = [];
class StubResizeObserver {
  constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; resizeObservers.push(this); }
  observe(el) { if (this.targets.indexOf(el) < 0) this.targets.push(el); }
  unobserve(el) { const i = this.targets.indexOf(el); if (i >= 0) this.targets.splice(i, 1); }
  disconnect() { this.targets.length = 0; this.disconnected = true; }
}
// Fire only the observers watching `el`. Scoping by target matters: a test file
// builds several viewers, and a notification delivered to a previous one's
// observer would run its debounce against the CURRENT test's fetch recorder.
export function fireResizeObservers(el) {
  for (const o of resizeObservers.slice()) {
    if (o.disconnected) continue;
    const targets = el ? o.targets.filter((t) => t === el) : o.targets;
    if (!targets.length) continue;
    o.cb(targets.map((t) => ({ target: t })), o);
  }
}

// ---- WebSocket recorder ----------------------------------------------------
export const webSockets = [];

class StubWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = StubWebSocket.OPEN; // pretend instant-open; onopen fired by test if needed
    this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    webSockets.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = StubWebSocket.CLOSED; if (this.onclose) this.onclose({}); }
}
StubWebSocket.CONNECTING = 0;
StubWebSocket.OPEN = 1;
StubWebSocket.CLOSING = 2;
StubWebSocket.CLOSED = 3;

export function findKbdSocket() {
  for (let i = webSockets.length - 1; i >= 0; i--) {
    if (webSockets[i].url.endsWith('/kbd')) return webSockets[i];
  }
  return null;
}

// Push a /kbd state frame at the viewer (drives applySignal).
export function pushSignal(state) {
  const s = findKbdSocket();
  if (!s || !s.onmessage) throw new Error('no /kbd socket captured');
  s.onmessage({ data: JSON.stringify(state) });
}

// ---- fake EditContext (Android EC profile) ----------------------------------
// Mirrors the API surface the core touches: .text, updateText, updateSelection,
// addEventListener. Tests mutate .text then fire 'textupdate' with the range,
// matching real EC ordering (buffer updated BEFORE the event fires).
export class FakeEditContext {
  constructor() {
    this.text = '';
    this._listeners = {};
  }
  updateText(start, end, t) { this.text = this.text.slice(0, start) + t + this.text.slice(end); }
  updateSelection() {}
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
}
export function fireEC(ec, type, props) {
  const e = Object.assign({
    type, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  }, props || {});
  for (const fn of (ec._listeners[type] || []).slice()) fn(e);
  return e;
}

// ---- profiles ---------------------------------------------------------------
const PROFILES = {
  ios: {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    maxTouchPoints: 5, coarse: true, editContext: false,
  },
  'android-input': { // Android WITHOUT EditContext → hidden-<input> value-diff path
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile',
    maxTouchPoints: 5, coarse: true, editContext: false,
  },
  'firefox-android': { // Gecko on Android — reports the keyboard unlike any Blink
    ua: 'Mozilla/5.0 (Android 14; Mobile; rv:154.0) Gecko/154.0 Firefox/154.0',
    maxTouchPoints: 5, coarse: true, editContext: false,
  },
  'android-ec': { // Android WITH EditContext → EC path
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile',
    maxTouchPoints: 5, coarse: true, editContext: true,
  },
  desktop: {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
    maxTouchPoints: 0, coarse: false, editContext: false,
  },
};

export function installGlobals(profileName, opts) {
  const p = PROFILES[profileName];
  if (!p) throw new Error('unknown profile ' + profileName);
  const o = opts || {};

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: p.ua,
      maxTouchPoints: p.maxTouchPoints,
      clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
      virtualKeyboard: null,
    },
    configurable: true, writable: true,
  });
  globalThis.location = {
    pathname: '/vnc/liveview.html',
    search: o.search || '', // e.g. '?magnify=1' — frozen into env.js at first import
    protocol: 'https:',
    host: 'viewer.test',
  };
  globalThis.window = globalThis;
  // Top-level by default. opts.embedded makes window !== window.top, which is how
  // the layer detects an embedded viewer (iframe focus claiming, the host-bridge's
  // inbound arming, the iOS raise-path branch). Must be set BEFORE the first
  // import of the core, since env.js/host-bridge.js freeze this at module init.
  globalThis.window.top = o.embedded ? {} : globalThis.window;
  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  globalThis.performance = { now: () => clockNow };
  globalThis.window.performance = globalThis.performance;
  const mm = (q) => ({ matches: p.coarse ? /coarse/.test(q) : /fine/.test(q) });
  globalThis.matchMedia = mm;
  globalThis.window.matchMedia = mm;
  vvListeners = {};
  globalThis.window.visualViewport = {
    height: 844,
    offsetTop: 0,
    addEventListener(type, fn) { (vvListeners[type] = vvListeners[type] || []).push(fn); },
  };
  // Window listeners are RECORDED (not dropped) so tests can drive window-level
  // events — 'message' from a host, and the online/pageshow/resize reconnect and
  // layout paths. Recording is inert on its own: a listener that is never fired
  // behaves exactly as the old noop did, which is why this doesn't disturb the
  // existing profiles.
  winListeners = {};
  globalThis.window.addEventListener = (type, fn) => {
    (winListeners[type] = winListeners[type] || []).push(fn);
  };
  globalThis.window.removeEventListener = (type, fn) => {
    const l = winListeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  globalThis.window.scrollTo = noop;
  globalThis.window.focus = noop;
  parentMessages.length = 0;
  globalThis.window.parent = { postMessage: (msg) => parentMessages.push(msg) };
  if (p.editContext) globalThis.window.EditContext = FakeEditContext;
  else delete globalThis.window.EditContext;

  const body = makeElement('body');
  docListeners = {};
  screenEl = null;
  globalThis.document = {
    createElement: makeElement,
    // Text nodes: the FedCM disclosure interleaves plain text with the terms and
    // privacy <a> elements, so it needs real text nodes rather than textContent
    // assignment. Minimal shape — appendChild only ever reads parentNode/children.
    createTextNode(text) {
      return { nodeType: 3, tagName: undefined, textContent: String(text), children: [], parentNode: null };
    },
    getElementById: (id) => (id === 'screen' ? screenEl : null),
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener: noop,
    body,
    documentElement: makeElement('html'),
    hidden: false,
    activeElement: null,
  };
  globalThis.getComputedStyle = () => ({ transform: 'none' });
  globalThis.Element = StubElement; // `target instanceof Element` in withinScreen
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  globalThis.WebSocket = StubWebSocket;
  resizeObservers.length = 0;
  globalThis.ResizeObserver = StubResizeObserver;
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; }; // synchronous double-rAF is fine
  // Intervals never self-tick (watchdog / polls / pings stay quiet); tests that
  // exercise interval-driven behavior call tickIntervals() to fire them once.
  intervals.length = 0;
  let intervalSeq = 0;
  globalThis.setInterval = (fn, ms) => { intervals.push({ id: ++intervalSeq, fn, ms }); return intervalSeq; };
  globalThis.clearInterval = (id) => {
    const i = intervals.findIndex((x) => x.id === id);
    if (i >= 0) intervals.splice(i, 1);
  };
  globalThis.fetch = () => Promise.resolve({ ok: true }); // /klog, /emulate
}

// ---- viewer bootstrap --------------------------------------------------------
const CORE_URL = new URL('../../kbd-autofocus.js', import.meta.url).href;
let importSeq = 0;

// Fresh core instance (cache-busted import) attached to a fresh mock RFB with
// 'connect' already fired (rfbReady=true). Returns everything a test touches.
export async function freshViewer(makeMockRfb) {
  // A new viewer is a new document: the previous one's proxy must not still read
  // as focused, or focus-sensitive paths see a detached element no browser would
  // report.
  globalThis.document.activeElement = null;
  importSeq++;
  await import(CORE_URL + '?fresh=' + importSeq);
  const kbd = globalThis.window.PopcornKbd;
  const rfb = makeMockRfb();
  kbd.attach(rfb);
  rfb.fireConnect();
  const proxy = findProxy();
  if (!proxy) throw new Error('proxy element not created — setup() did not run');
  return { kbd, rfb, proxy, kbdSock: findKbdSocket() };
}
