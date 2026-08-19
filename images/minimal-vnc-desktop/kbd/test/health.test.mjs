// health.test.mjs — the viewer's integration verdict, as sent to the embedder.
//
// The point of kbd/health.js is that a broken embedding stops being invisible: a
// code goes UP the bridge, where an integrator can alert on it, instead of into a
// console inside a cross-origin iframe on somebody's phone. So the properties
// worth locking are the ones that decide whether that is safe and useful to
// forward — it must carry no page content, it must not spam, and it must be
// cumulative enough that a host which mounts its listener late still learns what
// went wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.location = { search: '?kbddebug=1', pathname: '/vnc/liveview.html' };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', maxTouchPoints: 5 },
  configurable: true, writable: true,
});
globalThis.matchMedia = () => ({ matches: true });
globalThis.devicePixelRatio = 2.625;
globalThis.fetch = () => Promise.resolve({ ok: true });

// Capture what would go to the embedder. host-bridge posts through window.parent,
// and top-level that IS window — so a listener here sees every outbound message.
const posted = [];
globalThis.parent = { postMessage: (m) => posted.push(m) };
globalThis.addEventListener = globalThis.addEventListener || (() => {});

const { reportHealth, healthCodes, resetHealth } = await import('../health.js');

function reset() { posted.length = 0; resetHealth(); }

test('a code reaches the embedder as a structural message', () => {
  reset();
  assert.equal(reportHealth('host-geometry-blind', { hostOccluded: 0, localOccluded: 340 }), true);
  assert.equal(posted.length, 1);
  const m = posted[0];
  assert.equal(m.type, 'POPCORN_KBD_HEALTH');
  assert.equal(m.code, 'host-geometry-blind');
  assert.deepEqual(m.detail, { hostOccluded: 0, localOccluded: 340 });
});

test('unknown health codes are not forwarded', () => {
  reset();
  assert.equal(reportHealth('email=user@example.com'), false);
  assert.equal(posted.length, 0);
});

test('the payload is cumulative, so a host that mounts late still learns everything', () => {
  // The embedder's listener races our boot: an SDK loaded async, a framework
  // mounting its bridge on hydration. A host that missed the first message must
  // not be permanently blind to the condition it describes.
  reset();
  reportHealth('no-virtual-keyboard');
  reportHealth('focus-stolen');
  assert.deepEqual(posted[posted.length - 1].codes, ['no-virtual-keyboard', 'focus-stolen']);
  assert.deepEqual(healthCodes(), ['no-virtual-keyboard', 'focus-stolen']);
});

test('a repeating condition is reported once, not once per event', () => {
  // These fire from inside detectors that run on every viewport event. Reporting
  // per event would put a message on the embedder's bridge several times a second
  // during a keyboard animation, which is its own performance story.
  reset();
  for (let i = 0; i < 50; i++) reportHealth('focus-stolen');
  assert.equal(posted.length, 1, 'deduped');
});

test('detail carries NUMBERS only — nothing from the page can ride along', () => {
  // These lines are meant to be forwarded into somebody else's logging system, so
  // the privacy rule is the same as the layout audit's: codes and measurements,
  // never anything derived from content, URLs, or user input. A caller that gets
  // this wrong must fail closed rather than leak.
  reset();
  reportHealth('remote-unconfirmed', {
    pendingChars: 4,
    fieldValue: 'hunter2',           // a caller mistake
    url: 'https://portal.test/login',
    nested: { secret: 'x' },
    nan: NaN,
  });
  assert.deepEqual(posted[0].detail, { pendingChars: 4 }, 'strings and objects are dropped');
});

test('numbers are rounded, so a float cannot smuggle precision', () => {
  reset();
  reportHealth('host-geometry-disagrees', { hostOccluded: 339.7431, localOccluded: 12.5 });
  assert.deepEqual(posted[0].detail, { hostOccluded: 340, localOccluded: 13 });
});
