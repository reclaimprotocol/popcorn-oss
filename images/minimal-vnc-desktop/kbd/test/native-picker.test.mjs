import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobals, makeScreen } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' });
const { createNativePickerProxy } = await import('../native-picker.js');

test('page navigation clears advertised temporal picker hit targets', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const content = readFileSync(join(here, '..', '..', 'extensions', 'proxy', 'content.js'), 'utf8');
  const pagehide = content.match(/addEventListener\('pagehide',[\s\S]{0,300}?\}\);/);
  assert.ok(pagehide, 'content script has a pagehide cleanup handler');
  assert.match(pagehide[0], /pickers:\s*\[\]/, 'navigation publishes an empty picker descriptor list');
});

test('a transparent local date input maps over remote pixels and relays its normalized value', () => {
  makeScreen();
  const sent = [];
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: (choice) => { sent.push(choice); return true; },
  });
  proxy.setTransportReady(true);
  proxy.applySignal({
    editable: false,
    vw: 390,
    vh: 844,
    pickers: [{
      k: 'date:1', t: 'date', r: { x: 39, y: 84, w: 195, h: 64 },
      v: '2026-08-21', min: '2026-08-01', max: '2026-08-31', step: '1', a: 'Travel date',
    }],
  });

  const entry = proxy._entries().get('date:1');
  assert.ok(entry, 'local date input created');
  assert.equal(entry.el.type, 'date');
  assert.equal(entry.el.value, '2026-08-21');
  assert.equal(entry.el.getAttribute('min'), '2026-08-01');
  assert.equal(entry.el.getAttribute('max'), '2026-08-31');
  assert.equal(entry.el.style.display, 'block');
  assert.equal(entry.el.style.left, '39.00px');
  assert.match(entry.el.style.cssText, /color:transparent/);

  entry.el.value = '2026-08-22';
  for (const fn of entry.el._listeners.change || []) fn({ target: entry.el });
  assert.deepEqual(sent, [{ key: 'date:1', value: '2026-08-22' }]);
});

test('remote refresh preserves a focused date input and its in-progress picker value', () => {
  makeScreen();
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: () => true,
  });
  proxy.setTransportReady(true);
  const base = { editable: false, vw: 390, vh: 844 };
  proxy.applySignal({ ...base, pickers: [{ k: 'date:2', t: 'date', r: { x: 20, y: 40, w: 200, h: 60 }, v: '2026-08-21' }] });
  const original = proxy._entries().get('date:2').el;
  original.focus();
  original.value = '2026-08-22';

  proxy.applySignal({ ...base, pickers: [{ k: 'date:2', t: 'date', r: { x: 22, y: 42, w: 200, h: 60 }, v: '2026-08-21' }] });
  const refreshed = proxy._entries().get('date:2').el;
  assert.equal(refreshed, original, 'the focused picker owner is not replaced');
  assert.equal(document.activeElement, original);
  assert.equal(original.value, '2026-08-22', 'an open picker is not reset by a stale heartbeat');
});

test('socket loss removes the local date hit target', () => {
  makeScreen();
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: () => true,
  });
  proxy.setTransportReady(true);
  proxy.applySignal({
    editable: false, vw: 390, vh: 844,
    pickers: [{ k: 'date:3', t: 'date', r: { x: 20, y: 40, w: 200, h: 60 }, v: '2026-08-21' }],
  });
  const el = proxy._entries().get('date:3').el;
  assert.equal(el.style.display, 'block');
  proxy.setTransportReady(false);
  assert.equal(el.style.display, 'none');
});

test('time, datetime-local, month, and week use real local inputs and relay their native values', () => {
  makeScreen();
  const sent = [];
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: (choice) => { sent.push(choice); return true; },
  });
  proxy.setTransportReady(true);
  const values = {
    time: ['10:15', '11:30'],
    'datetime-local': ['2026-08-23T10:15', '2026-08-24T11:30'],
    month: ['2026-08', '2026-09'],
    week: ['2026-W34', '2026-W35'],
  };
  proxy.applySignal({
    editable: false, vw: 390, vh: 844,
    pickers: Object.entries(values).map(([type, pair], index) => ({
      k: `${type}:${index}`, t: type, r: { x: 20, y: 40 + index * 70, w: 250, h: 60 },
      v: pair[0], min: pair[0], max: pair[1], step: '1', req: true,
    })),
  });
  for (const [index, [type, pair]] of Object.entries(values).entries()) {
    const entry = proxy._entries().get(`${type}:${index}`);
    assert.ok(entry, `${type} local input created`);
    assert.equal(entry.el.type, type);
    assert.equal(entry.el.value, pair[0]);
    assert.equal(entry.el.required, true);
    entry.el.value = pair[1];
    for (const fn of entry.el._listeners.change || []) fn({ target: entry.el });
  }
  assert.deepEqual(sent, Object.entries(values).map(([type, pair], index) => ({
    key: `${type}:${index}`, value: pair[1],
  })));
});

test('a native picker reset relays the empty value for remote required validation', () => {
  makeScreen();
  const sent = [];
  const proxy = createNativePickerProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: (choice) => { sent.push(choice); return true; },
  });
  proxy.setTransportReady(true);
  proxy.applySignal({
    editable: false, vw: 390, vh: 844,
    pickers: [{ k: 'time:reset', t: 'time', r: { x: 20, y: 40, w: 200, h: 60 }, v: '10:15' }],
  });
  const el = proxy._entries().get('time:reset').el;
  el.value = '';
  for (const fn of el._listeners.change || []) fn({ target: el });
  assert.deepEqual(sent, [{ key: 'time:reset', value: '' }]);
});
