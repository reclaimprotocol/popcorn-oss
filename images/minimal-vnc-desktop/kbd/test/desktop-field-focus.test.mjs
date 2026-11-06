// desktop-field-focus.test.mjs — POPCORN_FIELD_FOCUS tells a configured embedder
// which kind of remote field is focused (never its value), and a host paste into
// a sensitive field never lands on the remote clipboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireHostMessage, pushSignal, parentMessages, clearWindowListeners } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('desktop', { embedded: true, search: '?parentOrigin=https://portal.test' });

async function viewer() {
  clearWindowListeners();
  return freshViewer(createMockRfb);
}

const field = (focusKey, hints, sync = {}) =>
  ({ editable: true, focusKey, rect: { x: 0, y: 0, w: 10, h: 10 }, hints, sync });
const reports = () => parentMessages.filter((m) => m.type === 'POPCORN_FIELD_FOCUS');

test('reports the focused field kind once per change, with no value', async () => {
  await viewer();
  parentMessages.length = 0;
  pushSignal(field('u1', { type: 'email', autoComplete: 'username' }, { val: 'me@x.test', len: 9 }));
  pushSignal(field('u1', { type: 'email', autoComplete: 'username' }, { val: 'me@x.test', len: 9 }));
  pushSignal(field('p1', { type: 'password', autoComplete: 'current-password' }, { sensitive: true }));
  assert.deepEqual(reports().map(({ kind, sensitive }) => ({ kind, sensitive })), [
    { kind: 'username', sensitive: false },
    { kind: 'password', sensitive: true },
  ]);
  assert.ok(!/me@x\.test/.test(JSON.stringify(reports())), 'never carries the field value');
});

test('classifies OTP and plain text fields', async () => {
  await viewer();
  parentMessages.length = 0;
  pushSignal(field('o1', { type: 'text', autoComplete: 'one-time-code' }, { sensitive: true }));
  pushSignal(field('t1', { type: 'text', name: 'search' }));
  assert.deepEqual(reports().map((m) => m.kind), ['otp', 'text']);
});

test('a host paste into a sensitive field types keysyms, even when long', async () => {
  const { rfb } = await viewer();
  pushSignal(field('p2', { type: 'password' }, { sensitive: true }));
  rfb.clearKeys();
  const secret = 'S'.repeat(40);
  fireHostMessage({ type: 'POPCORN_PASTE', text: secret });
  assert.deepEqual(rfb.clipboard, [], 'nothing staged on the remote clipboard');
  assert.deepEqual(rfb.tapped(), keysymsFor(secret));
});

test('reports null once the remote field is gone', async () => {
  await viewer();
  parentMessages.length = 0;
  pushSignal(field('p3', { type: 'password' }, { sensitive: true }));
  pushSignal({ editable: false });
  await new Promise((resolve) => setTimeout(resolve, 1500)); // past the false-dismiss grace
  pushSignal({ editable: false });
  // The report is deduped per process, so the previous test's password field may
  // have suppressed this one; what matters is that the last word is null.
  assert.equal(reports().at(-1)?.kind, null);
});
