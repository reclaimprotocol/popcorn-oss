// android-ec.test.mjs — characterization: Android EditContext path (mainstream
// Chromium). The EC buffer is authoritative; textupdate reports range edits.
// Real EC updates the buffer BEFORE firing textupdate — tests mirror that
// ordering (set ec.text, then fireEC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { installGlobals, freshViewer, fire, fireEC } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, BS, ENTER } from './mock-rfb.mjs';

installGlobals('android-ec');

async function ecViewer() {
  const v = await freshViewer(createMockRfb);
  const ec = v.proxy.editContext;
  assert.ok(ec, 'EditContext path not taken — proxy has no editContext');
  return { ...v, ec };
}

test('committed text is sent and the buffer reset between commits', async () => {
  const { rfb, ec } = await ecViewer();
  ec.text = 'h';
  fireEC(ec, 'textupdate', { text: 'h', updateRangeStart: 0, updateRangeEnd: 0 });
  assert.deepEqual(rfb.tapped(), keysymsFor('h'));
  assert.equal(ec.text, ''); // resetEC keeps deltas fresh
});

test('range deletion translates to that many Backspaces', async () => {
  const { rfb, ec } = await ecViewer();
  ec.text = '';
  fireEC(ec, 'textupdate', { text: '', updateRangeStart: 0, updateRangeEnd: 2 });
  assert.deepEqual(rfb.tapped(), [BS, BS]);
});

test('SwiftKey re-compose reconcile: committed word is deleted before the re-grab replays it', async () => {
  const { rfb, ec } = await ecViewer();
  // SwiftKey commits 'test' as ordinary text (non-composing)…
  ec.text = 'test';
  fireEC(ec, 'textupdate', { text: 'test', updateRangeStart: 0, updateRangeEnd: 0 });
  rfb.clearKeys();
  // …then re-composes the whole word (autocorrect/candidate pick).
  fireEC(ec, 'compositionstart', {});
  ec.text = 'test';
  fireEC(ec, 'textupdate', { text: 'test', updateRangeStart: 0, updateRangeEnd: 0 });
  // Reconcile: BS×4 (drop the committed word) then the composing word replaces it.
  assert.deepEqual(rfb.tapped(), [BS, BS, BS, BS, ...keysymsFor('test')]);
});

test('glide/CJK composition from an EMPTY buffer never triggers the reconcile', async () => {
  const { rfb, ec } = await ecViewer();
  fireEC(ec, 'compositionstart', {});
  ec.text = '가';
  fireEC(ec, 'textupdate', { text: '가', updateRangeStart: 0, updateRangeEnd: 0 });
  assert.deepEqual(rfb.tapped(), keysymsFor('가')); // no backspaces
});

test('compositionend after a forwarded composition does not double-send', async () => {
  const { rfb, ec } = await ecViewer();
  fireEC(ec, 'compositionstart', {});
  ec.text = '가';
  fireEC(ec, 'textupdate', { text: '가', updateRangeStart: 0, updateRangeEnd: 0 });
  rfb.clearKeys();
  fireEC(ec, 'compositionend', {});
  assert.deepEqual(rfb.tapped(), []); // final text already went out
  assert.equal(ec.text, ''); // buffer cleared for the next word
});

test('Backspace on an empty buffer deletes on the remote immediately', async () => {
  const { rfb, proxy, ec } = await ecViewer();
  assert.equal(ec.text, '');
  const e = fire(proxy, 'keydown', { key: 'Backspace', keyCode: 8 });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), [BS]);
});

test('Unidentified keydown defers a backspace that a REAL character textupdate cancels', async () => {
  const { rfb, proxy, ec } = await ecViewer();
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  ec.text = 'a';
  fireEC(ec, 'textupdate', { text: 'a', updateRangeStart: 0, updateRangeEnd: 0 }); // cancels
  await sleep(150);
  assert.deepEqual(rfb.tapped(), keysymsFor('a')); // no spurious Backspace
});

test('SwiftKey phantom delete (empty non-composing textupdate) does NOT cancel the deferred backspace', async () => {
  const { rfb, proxy, ec } = await ecViewer();
  fire(proxy, 'keydown', { key: 'Unidentified', keyCode: 229 });
  ec.text = '';
  fireEC(ec, 'textupdate', { text: '', updateRangeStart: 0, updateRangeEnd: 0 }); // phantom
  await sleep(150);
  assert.deepEqual(rfb.tapped(), [BS]); // the deferred delete reached the remote
});

test('Enter sends the action key and resets the buffer', async () => {
  const { rfb, proxy, ec } = await ecViewer();
  ec.text = 'x';
  const e = fire(proxy, 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.tapped(), [ENTER]);
  assert.equal(ec.text, '');
});
