// native-picker.js — local platform-native temporal inputs over remote pixels.
//
// The remote Chromium calendar is not a reliable streamed interaction surface.
// A transparent real input in the mobile viewer receives the user's tap, so iOS
// owns the calendar UI. Its normalized value is relayed to the matching remote
// input after validation at every hop.

import { dbg } from './diag.js';
import { createRectFreshness } from './rect-freshness.js';
import { mapSelectRect } from './native-select.js';

const ROOT_ATTR = 'data-popcorn-native-picker-root';
const INPUT_ATTR = 'data-popcorn-native-picker';
const SUPPORTED_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

function pickerLabel(type) {
  if (type === 'time') return 'Choose time';
  if (type === 'datetime-local') return 'Choose date and time';
  if (type === 'month') return 'Choose month';
  if (type === 'week') return 'Choose week';
  return 'Choose date';
}

export function createNativePickerProxy({ enabled, getScreenElement, sendChoice }) {
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

  function setOptional(el, name, value) {
    const v = String(value || '');
    if (v) el.setAttribute(name, v);
    else el.removeAttribute(name);
  }

  function syncElement(el, d, preserveActive) {
    el.type = d.t;
    if (el.type !== d.t) return false;
    el.setAttribute('aria-label', d.a || pickerLabel(d.t));
    setOptional(el, 'min', d.min);
    setOptional(el, 'max', d.max);
    setOptional(el, 'step', d.step);
    el.required = !!d.req;
    if (!preserveActive) el.value = String(d.v || '');
    return true;
  }

  function build(d) {
    const el = document.createElement('input');
    el.setAttribute(INPUT_ATTR, d.k);
    el.style.cssText = [
      'position:fixed', 'display:none', 'z-index:2147483646', 'box-sizing:border-box',
      'margin:0', 'padding:0', 'border:0', 'border-radius:0', 'background:transparent',
      'color:transparent', '-webkit-text-fill-color:transparent', 'font-size:16px',
      'pointer-events:auto', 'touch-action:manipulation', '-webkit-tap-highlight-color:transparent',
    ].join(';');
    if (!syncElement(el, d, false)) return null;
    el.addEventListener('change', () => {
      const value = String(el.value || '');
      if (!transportReady) return;
      const ok = sendChoice({ key: d.k, value });
      dbg('native picker choice key=' + d.k + ' type=' + d.t + ' sent=' + (ok ? 1 : 0));
      if (!ok) setTransportReady(false);
    });
    root.appendChild(el);
    return { el, descriptor: d };
  }

  function syncEntries() {
    const wanted = new Set(descriptors.map((d) => d.k));
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue;
      entry.el.remove();
      entries.delete(key);
    }
    for (const d of descriptors) {
      if (!d || typeof d.k !== 'string' || !d.r || !SUPPORTED_TYPES.has(d.t)) continue;
      let entry = entries.get(d.k);
      if (!entry) {
        entry = build(d);
        if (entry) entries.set(d.k, entry);
      } else {
        entry.descriptor = d;
        if (!syncElement(entry.el, d, document.activeElement === entry.el)) {
          entry.el.remove();
          entries.delete(d.k);
        }
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
    descriptors = Array.isArray(state.pickers) ? state.pickers : [];
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
    owns(target) {
      if (!target) return false;
      for (const entry of entries.values()) if (entry.el === target || entry.el.contains(target)) return true;
      return false;
    },
    _root: () => root,
    _entries: () => entries,
  };
}
