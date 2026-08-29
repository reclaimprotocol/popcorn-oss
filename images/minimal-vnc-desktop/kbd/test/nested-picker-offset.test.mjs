// nested-picker-offset.test.mjs — a date-of-birth picker three frames deep, iOS.
//
// The shape that matters: a host app's web view loads our page, that page embeds
// a partner frame, and the partner frame embeds the form that actually holds the
// <input type="date">. content.js runs in EVERY frame and measures frame-local
// rects; emit() shifts them into top-window coords with the offset accumulated
// down the chain, because the viewer maps a descriptor rect straight onto
// framebuffer pixels. A control whose rect skips that shift gets its transparent
// local input pinned over the wrong pixels — at depth 3 the miss is the sum of
// both iframe origins, so the user taps the DOB field and nothing opens, or a
// neighbouring control opens instead. Pickers were the one descriptor kind
// offsetState never shifted.
//
// The Android half of this cell is nested-picker-offset-android.test.mjs; the
// device-level pair is mobile-harness/cases/nested-webview-dob-picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, makeScreen } from './stub-dom.mjs';
import { loadOffsetState, CHAIN, nestedState } from './content-offset.mjs';

installGlobals('ios', { search: '?magnify=1' });
const { createNativePickerProxy } = await import('../native-picker.js');

const offsetState = loadOffsetState();

test('a date-of-birth picker three frames deep reports its rect in top-window coords', () => {
  const state = offsetState(nestedState(), CHAIN.x, CHAIN.y);

  assert.deepEqual(state.rects[0], { x: 40, y: 536, w: 342, h: 56 }, 'text field rect shifted');
  assert.deepEqual(state.selects[0].r, { x: 40, y: 616, w: 342, h: 56 }, 'select rect shifted');
  assert.deepEqual(state.pickers[0].r, { x: 40, y: 456, w: 342, h: 56 },
    'the picker rect is shifted by the same accumulated frame offset');
});

test('offsetting a picker preserves the descriptor the viewer validates against', () => {
  const p = offsetState(nestedState(), CHAIN.x, CHAIN.y).pickers[0];
  assert.equal(p.k, 'dob:1');
  assert.equal(p.t, 'date');
  assert.equal(p.v, '1994-03-17');
  assert.equal(p.min, '1900-01-01');
  assert.equal(p.max, '2008-12-31');
  assert.equal(p.req, true);
  assert.equal(p.a, 'Date of birth');
});

test('the picker list is cloned, so a cached descriptor is not re-offset each emit', () => {
  // report() reuses cachedPickers across emits; shifting in place would walk the
  // rect further down the page on every heartbeat.
  const cached = nestedState();
  const original = cached.pickers[0];
  const first = offsetState(cached, CHAIN.x, CHAIN.y);
  assert.notEqual(first.pickers[0], original, 'a new descriptor object is emitted');
  assert.deepEqual(original.r, { x: 24, y: 220, w: 342, h: 56 }, 'the cached rect is untouched');
});

test('a top-level page pays nothing for the offset path', () => {
  const state = nestedState();
  const same = offsetState(state, 0, 0);
  assert.equal(same, state);
  assert.deepEqual(same.pickers[0].r, { x: 24, y: 220, w: 342, h: 56 });
});

test('the local date input lands on the remote pixels of a depth-3 field', () => {
  makeScreen();
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: () => true,
  });
  proxy.setTransportReady(true);
  proxy.applySignal(offsetState(nestedState(), CHAIN.x, CHAIN.y));

  const entry = proxy._entries().get('dob:1');
  assert.ok(entry, 'local date input created for the nested field');
  assert.equal(entry.el.type, 'date');
  assert.equal(entry.el.style.display, 'block');
  // makeScreen()'s canvas is 1:1 with the 390x844 viewport at the origin, so the
  // overlay sits exactly where the remote field is.
  assert.equal(entry.el.style.left, '40.00px');
  assert.equal(entry.el.style.top, '456.00px');
});

test('the chosen date relays back with the key the nested frame advertised', () => {
  makeScreen();
  const sent = [];
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: (choice) => { sent.push(choice); return true; },
  });
  proxy.setTransportReady(true);
  proxy.applySignal(offsetState(nestedState(), CHAIN.x, CHAIN.y));

  const el = proxy._entries().get('dob:1').el;
  el.value = '1994-03-18';
  for (const fn of el._listeners.change || []) fn({ target: el });
  // The key is frame-local identity, never a coordinate — it must survive the
  // shift so background.js can route the choice back to the frame that owns it.
  assert.deepEqual(sent, [{ key: 'dob:1', value: '1994-03-18' }]);
});
