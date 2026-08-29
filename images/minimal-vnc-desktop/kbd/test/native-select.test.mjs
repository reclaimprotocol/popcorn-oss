import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, makeScreen } from './stub-dom.mjs';

installGlobals('ios', { search: '?magnify=1' });
const { createNativeSelectProxy, mapSelectRect } = await import('../native-select.js');

test('remote CSS geometry maps through the transformed canvas rectangle', () => {
  const box = mapSelectRect(
    { x: 100, y: 200, w: 200, h: 80 },
    { w: 1000, h: 800 },
    { left: 10, top: 20, width: 500, height: 400 },
  );
  assert.deepEqual(box, { left: 60, top: 120, width: 100, height: 40 });
});

test('a real transparent select is positioned over pixels and sends original option index', () => {
  makeScreen();
  const sent = [];
  const proxy = createNativeSelectProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: (choice) => { sent.push(choice); return true; },
  });
  proxy.setTransportReady(true);
  proxy.applySignal({
    editable: false,
    vw: 390,
    vh: 844,
    selects: [{
      k: 'page:1', r: { x: 39, y: 84, w: 195, h: 64 }, s: 0, a: 'Account type',
      o: [
        { i: 0, t: 'Personal', d: false },
        { i: 1, t: 'Business', d: false },
        { i: 2, t: 'Enterprise', d: true },
      ],
    }],
  });

  const entry = proxy._entries().get('page:1');
  assert.ok(entry, 'local select created');
  assert.equal(entry.el.style.display, 'block');
  assert.equal(entry.el.style.left, '39.00px');
  assert.equal(entry.el.style.top, '84.00px');
  assert.equal(entry.el.style.width, '195.00px');
  assert.equal(entry.el.style.height, '64.00px');
  assert.equal(entry.el.style.opacity, undefined, 'the hit target is not hidden with opacity');
  assert.match(entry.el.style.cssText, /color:transparent/);

  entry.el.value = '1';
  for (const fn of entry.el._listeners.change || []) fn({ target: entry.el });
  assert.deepEqual(sent, [{ key: 'page:1', index: 1 }]);
});

test('socket loss immediately removes native hit targets so remote fallback can receive taps', () => {
  makeScreen();
  const proxy = createNativeSelectProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: () => true,
  });
  proxy.setTransportReady(true);
  proxy.applySignal({
    editable: false, vw: 390, vh: 844,
    selects: [{ k: 'page:2', r: { x: 20, y: 40, w: 200, h: 60 }, s: 0, o: [{ i: 0, t: 'A' }] }],
  });
  const el = proxy._entries().get('page:2').el;
  assert.equal(el.style.display, 'block');
  proxy.setTransportReady(false);
  assert.equal(el.style.display, 'none');
});

test('dynamic options update the focused select in place and preserve the native picker owner', () => {
  makeScreen();
  const sent = [];
  const proxy = createNativeSelectProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: (choice) => { sent.push(choice); return true; },
  });
  proxy.setTransportReady(true);
  const base = { editable: false, vw: 390, vh: 844 };
  proxy.applySignal({
    ...base,
    selects: [{
      k: 'dynamic:1', r: { x: 20, y: 40, w: 200, h: 60 }, s: 0,
      o: [{ i: 0, t: 'Personal' }, { i: 1, t: 'Business' }, { i: 2, t: 'Enterprise' }],
    }],
  });
  const original = proxy._entries().get('dynamic:1').el;
  original.focus();

  proxy.applySignal({
    ...base,
    selects: [{
      k: 'dynamic:1', r: { x: 20, y: 40, w: 200, h: 60 }, s: 0,
      o: [
        { i: 0, t: 'Personal' }, { i: 1, t: 'Team' },
        { i: 2, t: 'Business' }, { i: 3, t: 'Enterprise' },
      ],
    }],
  });

  const refreshed = proxy._entries().get('dynamic:1').el;
  assert.equal(refreshed, original, 'the focused select node must not be replaced');
  assert.equal(document.activeElement, original, 'focus/native picker ownership is preserved');
  assert.deepEqual(original.children.map((option) => option.textContent),
    ['Personal', 'Team', 'Business', 'Enterprise']);
  original.value = '2';
  for (const fn of original._listeners.change || []) fn({ target: original });
  assert.deepEqual(sent, [{ key: 'dynamic:1', index: 2 }]);
});

// The page can put its own modal over everything (injected.js swaps a huge
// list's OS dropdown for an in-page sheet), and the extension then advertises no
// selects at all. Local hit targets must go with them, or a sheet row drawn over
// one is untappable and the tap opens the wrong control.
test('withdrawing the advertised selects removes the local hit targets', () => {
  makeScreen();
  const proxy = createNativeSelectProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: () => true,
  });
  proxy.setTransportReady(true);
  const signal = (selects) => proxy.applySignal({ editable: false, vw: 390, vh: 844, selects });
  signal([{ k: 'page:2', r: { x: 20, y: 40, w: 200, h: 60 }, s: 0, o: [{ i: 0, t: 'A' }] }]);
  const el = proxy._entries().get('page:2').el;
  assert.equal(el.style.display, 'block');

  signal([]);
  assert.equal(proxy._entries().size, 0, 'entry survived an empty advertisement');
  assert.ok(!el.isConnected || el.style.display === 'none', 'hit target still over the pixels');

  // And they come back when the sheet closes and the selects are advertised again.
  signal([{ k: 'page:2', r: { x: 20, y: 40, w: 200, h: 60 }, s: 0, o: [{ i: 0, t: 'A' }] }]);
  assert.equal(proxy._entries().get('page:2').el.style.display, 'block');
});

// Rects are viewport-relative, so they only mean anything at the scroll offset
// they were measured at. A page still gliding under a fling publishes a new
// offset every time, and a hit target placed from one of those sits beside the
// control the user sees.
test('hit targets wait for two states to agree on the scroll offset', () => {
  makeScreen();
  const proxy = createNativeSelectProxy({
    enabled: true,
    getScreenElement: () => document.getElementById('screen'),
    sendChoice: () => true,
  });
  proxy.setTransportReady(true);
  const at = (sy) => proxy.applySignal({
    editable: false, vw: 390, vh: 844, sy,
    selects: [{ k: 'page:2', r: { x: 20, y: 40, w: 200, h: 60 }, s: 0, o: [{ i: 0, t: 'A' }] }],
  });

  at(0);
  const el = proxy._entries().get('page:2').el;
  assert.equal(el.style.display, 'none', 'went live off a single unconfirmed offset');
  at(0);
  assert.equal(el.style.display, 'block', 'never went live on a settled page');

  // Scrolling again — each state describes a page that has already moved on.
  at(120);
  assert.equal(el.style.display, 'none', 'stayed live while the page was still moving');
  at(240);
  assert.equal(el.style.display, 'none', 'a second moving state is still not agreement');
  at(240);
  assert.equal(el.style.display, 'block', 'never recovered once the scroll settled');

  // A publisher that stops reporting the offset must not cost the control — an
  // extension too old to send one keeps the behaviour it always had.
  proxy.applySignal({
    editable: false, vw: 390, vh: 844,
    selects: [{ k: 'page:2', r: { x: 20, y: 40, w: 200, h: 60 }, s: 0, o: [{ i: 0, t: 'A' }] }],
  });
  assert.equal(el.style.display, 'block', 'a missing offset took the control away');
});
