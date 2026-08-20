// host-stub.mjs — load host/popcorn-host.js the way a browser would.
//
// popcorn-host.js is a classic script an integrator drops into their page, not a
// module, so it cannot be imported: it assigns window.PopcornHost. This evaluates
// it against a hand-built window whose only job is to be honest about the four
// things the layout audit reads — getComputedStyle, the parent chain,
// getBoundingClientRect, and the viewport size. Elements are plain objects with a
// `style` map; a test writes the shape it wants to characterise and asks what the
// audit says about it.
//
// Deliberately NOT jsdom (this repo's suites are zero-dependency), and
// deliberately not the viewer's stub-dom: that one models the VIEWER's document
// (canvas, visualViewport, keyboard detectors) and this is the page ABOVE it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', '..', 'host', 'popcorn-host.js'), 'utf8');

/** A style map that answers every property the audit asks about with a default. */
function styleFor(overrides) {
  const base = {
    position: 'static', display: 'block', transform: 'none', rotate: 'none',
    scale: 'none', translate: 'none', perspective: 'none', filter: 'none',
    backdropFilter: 'none', clipPath: 'none', maskImage: 'none', zoom: '1',
    contain: 'none', contentVisibility: 'visible', willChange: 'auto',
    opacity: '1', overflowX: 'visible', overflowY: 'visible',
    borderTopWidth: '0px', borderLeftWidth: '0px',
  };
  return Object.assign(base, overrides || {});
}

export function makeEl(tagName, style, rect) {
  const el = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    childNodes: [],
    parentNode: null,
    style: styleFor(style),
    attrs: {},
    _rect: rect || null,
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    appendChild(child) {
      if (child.parentNode) {
        const i = child.parentNode.childNodes.indexOf(child);
        if (i >= 0) child.parentNode.childNodes.splice(i, 1);
      }
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    getBoundingClientRect() {
      // Inherit the nearest explicit rect, so a wrapper chain does not have to
      // restate the geometry at every level.
      let n = this;
      while (n && !n._rect) n = n.parentNode;
      const r = (n && n._rect) || { left: 0, top: 0, width: 0, height: 0 };
      return Object.assign({ right: r.left + r.width, bottom: r.top + r.height }, r);
    },
  };
  // `style.cssText = ...` is how layer() writes the contract; parse it back into
  // the map so the audit sees the result, exactly as a browser would.
  let cssText = '';
  Object.defineProperty(el.style, 'cssText', {
    get() { return cssText; },
    set(v) {
      cssText = String(v);
      for (const decl of cssText.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const k = decl.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.style[k] = decl.slice(i + 1).trim();
      }
      if (el.style.border === '0') { el.style.borderTopWidth = '0px'; el.style.borderLeftWidth = '0px'; }
    },
    configurable: true,
  });
  return el;
}

/**
 * Build a window with `chain` wrapping the iframe: chain[0] is the outermost
 * element under <body>. Returns { win, iframe, body, warnings, posted }.
 *
 * `viewport` is the window's own size, so a test can make the iframe smaller than
 * the viewport (the 'not-full-viewport' case) without touching anything else.
 */
export function makeHostWindow({ chain = [], iframeStyle, viewport = { w: 411, h: 732 }, iframeRect, dpr = 3, top = true } = {}) {
  const warnings = [];
  const infos = [];
  const posted = [];        // messages posted DOWN to the child frame
  const parentPosted = [];  // messages posted UP to our own parent
  const listeners = {};

  const documentElement = makeEl('html');
  const body = makeEl('body', null, { left: 0, top: 0, width: viewport.w, height: viewport.h });
  documentElement.appendChild(body);

  const iframe = makeEl('iframe', iframeStyle, iframeRect || null);
  let parent = body;
  for (const spec of chain) {
    const el = makeEl(spec.tag || 'div', spec.style, spec.rect || null);
    parent.appendChild(el);
    parent = el;
  }
  parent.appendChild(iframe);

  // A REAL <iframe> in a real document always has a contentWindow AND a
  // contentDocument the moment it is parsed — it is showing about:blank until a
  // src navigates it. Modelling only contentWindow made the stub disagree with
  // every browser about the one thing layer() branches on, and the disagreement
  // hid a live bug: layer() called BEFORE src (the documented recipe) saw a
  // non-null contentDocument, decided the frame was live, and refused to reparent
  // it out of the embedder's wrapper. So the stub carries the blank document too,
  // and `navigated` is how a test says the frame has actually gone somewhere.
  const childWindow = { postMessage: (m) => posted.push(m), location: { href: 'about:blank' } };
  iframe.contentWindow = childWindow;
  iframe.contentDocument = { URL: 'about:blank' };
  iframe.navigate = function (href) {
    childWindow.location.href = href;
    iframe.contentDocument = { URL: href };
  };

  const win = {
    innerWidth: viewport.w,
    innerHeight: viewport.h,
    devicePixelRatio: dpr,
    visualViewport: { width: viewport.w, height: viewport.h, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
    navigator: {},
    location: { search: '', origin: 'https://portal.test' },
    console: { warn: (m) => warnings.push(String(m)), info: (m) => infos.push(String(m)) },
    document: { documentElement, body },
    parent: { postMessage: (m) => parentPosted.push(m) },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const l = listeners[type];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: (el) => el.style,
    URLSearchParams,
  };
  win.top = top ? win : { different: true };
  win.window = win;

  // The script ends with `})(typeof window !== 'undefined' ? window : this)`, so
  // the fake has to be bound as `window` — binding it as some other name would let
  // it fall through to Node's real globalThis and assign PopcornHost there.
  // eslint-disable-next-line no-new-func
  new Function('window', 'URLSearchParams', SRC)(win, URLSearchParams);

  return {
    win,
    PopcornHost: win.PopcornHost,
    iframe,
    body,
    childWindow,
    warnings,
    infos,
    posted,
    parentPosted,
    /** Deliver a message from the child viewer, the way the real bridge does. */
    fromChild(data) {
      for (const fn of listeners.message || []) fn({ data, source: childWindow, origin: 'https://pod.test' });
    },
    /**
     * Fire a window-level event (the real re-measure trigger: popcorn-host listens
     * for 'resize' on the window in startMeasuring). setInterval is inert in this
     * stub by design, so the 3s geometry heartbeat never self-ticks — a test that
     * wants another measurement asks for one the way the browser would.
     */
    fireWindow(type) {
      for (const fn of listeners[type] || []) fn({ type });
    },
    /** Deliver a message from our own parent (the outer host in a nested chain). */
    fromParent(data) {
      for (const fn of listeners.message || []) fn({ data, source: win.parent, origin: 'https://outer.test' });
    },
  };
}
