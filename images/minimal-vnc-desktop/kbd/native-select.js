// native-select.js — local platform-native <select> proxies over remote pixels.
//
// Chromium's GTK dropdown is not part of the VNC framebuffer in a usable way, so
// the remote extension historically replaced it with a DOM bottom sheet. On a
// phone that works but looks foreign. The extension now publishes bounded select
// descriptors ahead of the tap; this module aligns REAL local <select> elements
// over those framebuffer pixels. Safari/Chrome therefore own the picker UI.
//
// The proxy must remain rendered and hit-testable. iOS 26 did not activate a
// nearly transparent (opacity:.01) select in the simulator. Instead only its
// paint (background/text/border/appearance) is transparent — the element itself
// remains a normal interactive form control.

import { dbg } from './diag.js';
import { createRectFreshness } from './rect-freshness.js';

const ROOT_ATTR = 'data-popcorn-native-select-root';
const SELECT_ATTR = 'data-popcorn-native-select';

export function mapSelectRect(rect, viewport, canvasRect) {
  if (!rect || !viewport || !canvasRect || viewport.w <= 0 || viewport.h <= 0 ||
      canvasRect.width <= 0 || canvasRect.height <= 0) return null;
  const left = canvasRect.left + rect.x * canvasRect.width / viewport.w;
  const top = canvasRect.top + rect.y * canvasRect.height / viewport.h;
  const width = rect.w * canvasRect.width / viewport.w;
  const height = rect.h * canvasRect.height / viewport.h;
  const x1 = Math.max(0, left), y1 = Math.max(0, top);
  const x2 = Math.min(window.innerWidth, left + width);
  const y2 = Math.min(window.innerHeight, top + height);
  if (x2 - x1 < 8 || y2 - y1 < 8) return null;
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
}

export function createNativeSelectProxy({ enabled, getScreenElement, sendChoice }) {
  let transportReady = false;
  let viewport = null;
  let descriptors = [];
  let raf = 0;
  let observedCanvas = null;
  let resizeObserver = null;
  const entries = new Map();

  const root = document.createElement('div');
  root.setAttribute(ROOT_ATTR, '1');
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;background:transparent;';
  if (document.body) document.body.appendChild(root);

  function optionShape(d) {
    try { return JSON.stringify([d.k, d.a || '', d.o || []]); } catch (_) { return d.k; }
  }

  // Keep the SELECT node itself stable. iOS updates an open native picker when
  // the option children of its focused select change, but dismisses the picker
  // if that select element is removed. Dynamic forms commonly replace/reorder
  // options after an API response, so rebuild only the children in place.
  function replaceOptions(el, d) {
    while (el.children && el.children.length) el.removeChild(el.children[0]);
    let parent = el;
    let groupKey = null;
    for (const item of d.o || []) {
      if (item.g !== undefined) {
        const nextKey = String(item.g) + '|' + (item.gd ? '1' : '0');
        if (nextKey !== groupKey) {
          parent = document.createElement('optgroup');
          parent.label = String(item.g || '');
          parent.disabled = !!item.gd;
          el.appendChild(parent);
          groupKey = nextKey;
        }
      } else {
        parent = el;
        groupKey = null;
      }
      const opt = document.createElement('option');
      opt.value = String(item.i);
      opt.textContent = String(item.t || '');
      opt.disabled = !!item.d;
      parent.appendChild(opt);
    }
    el.value = String(d.s);
  }

  function build(d) {
    const el = document.createElement('select');
    el.setAttribute(SELECT_ATTR, d.k);
    el.setAttribute('aria-label', d.a || 'Select option');
    el.style.cssText = [
      'position:fixed', 'display:none', 'z-index:2147483646', 'box-sizing:border-box',
      'margin:0', 'padding:0', 'border:0', 'border-radius:0', 'background:transparent',
      'color:transparent', '-webkit-appearance:none', 'appearance:none',
      'font-size:16px', 'pointer-events:auto', 'touch-action:manipulation',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');

    replaceOptions(el, d);
    el.addEventListener('change', () => {
      const index = Number(el.value);
      if (!transportReady || !Number.isInteger(index)) return;
      const ok = sendChoice({ key: d.k, index });
      dbg('native select choice key=' + d.k + ' index=' + index + ' sent=' + (ok ? 1 : 0));
      if (!ok) setTransportReady(false);
    });
    root.appendChild(el);
    return { el, descriptor: d, shape: optionShape(d) };
  }

  function syncEntries() {
    const wanted = new Set(descriptors.map((d) => d.k));
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue;
      entry.el.remove();
      entries.delete(key);
    }
    for (const d of descriptors) {
      if (!d || typeof d.k !== 'string' || !d.r || !Array.isArray(d.o) || !d.o.length) continue;
      const shape = optionShape(d);
      let entry = entries.get(d.k);
      if (!entry) {
        entry = build(d);
        entries.set(d.k, entry);
      } else {
        entry.descriptor = d;
        if (entry.shape !== shape) {
          replaceOptions(entry.el, d);
          entry.shape = shape;
          dbg('native select options refreshed key=' + d.k + ' n=' + d.o.length);
        } else if (document.activeElement !== entry.el) {
          entry.el.value = String(d.s);
        }
        entry.el.setAttribute('aria-label', d.a || 'Select option');
      }
    }
  }

  function observeCanvas(canvas) {
    if (canvas === observedCanvas) return;
    if (resizeObserver) resizeObserver.disconnect();
    observedCanvas = canvas;
    if (canvas && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => refresh());
      resizeObserver.observe(canvas);
    }
  }

  function position() {
    raf = 0;
    const screen = getScreenElement && getScreenElement();
    const canvas = screen && screen.querySelector && screen.querySelector('canvas');
    observeCanvas(canvas);
    const cr = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    for (const entry of entries.values()) {
      const box = enabled && transportReady && freshness.fresh() ? mapSelectRect(entry.descriptor.r, viewport, cr) : null;
      if (!box) {
        entry.el.style.display = 'none';
        continue;
      }
      entry.el.style.display = 'block';
      entry.el.style.left = box.left.toFixed(2) + 'px';
      entry.el.style.top = box.top.toFixed(2) + 'px';
      entry.el.style.width = box.width.toFixed(2) + 'px';
      entry.el.style.height = box.height.toFixed(2) + 'px';
    }
  }

  function refresh() {
    if (raf) return;
    raf = requestAnimationFrame(position);
  }

  const freshness = createRectFreshness();
  function noteRemoteScroll() { freshness.stale(); refresh(); }

  function applySignal(state) {
    if (!state || typeof state.editable !== 'boolean') return;
    if (state.vw > 0 && state.vh > 0) viewport = { w: state.vw, h: state.vh };
    freshness.note(state.sy);
    descriptors = Array.isArray(state.selects) ? state.selects : [];
    syncEntries();
    refresh();
  }

  function setTransportReady(on) {
    transportReady = !!on;
    refresh();
  }

  function reset() {
    descriptors = [];
    for (const entry of entries.values()) entry.el.remove();
    entries.clear();
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    observedCanvas = null;
  }

  window.addEventListener('resize', refresh);

  return {
    applySignal, setTransportReady, refresh, reset, noteRemoteScroll,
    // What the hit targets think is at a point, for the tap diag: a break reads as
    // the nearest overlay being offset, inert, or absent.
    describeAt(x, y) {
      let best = null;
      for (const entry of entries.values()) {
        const r = entry.el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
        const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
        const gap = Math.max(dx, dy);
        if (!best || gap < best.gap) {
          best = { gap, k: entry.descriptor && entry.descriptor.k, live: entry.el.style.display !== 'none' };
        }
      }
      if (!best) return 'none';
      if (best.gap === 0) return best.k + (best.live ? '' : '/inert');
      return best.k + '+' + Math.round(best.gap) + 'px' + (best.live ? '' : '/inert');
    },
    owns(target) {
      if (!target) return false;
      for (const entry of entries.values()) if (entry.el === target || entry.el.contains(target)) return true;
      return false;
    },
    _root: () => root,
    _entries: () => entries,
  };
}
