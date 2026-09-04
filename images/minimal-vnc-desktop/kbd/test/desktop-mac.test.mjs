// desktop-mac.test.mjs — the macOS ⌥ guard. Its own file because the profile is
// pinned per PROCESS (see stub-dom.mjs): desktop.test.mjs runs the Windows UA,
// where ⌥ stays a command modifier and must keep reaching the remote.
//
// Regression: ⌥e (acute dead key) with the canvas focused was forwarded raw by
// noVNC as Alt+E, which on the remote Linux Chromium is the app-menu accelerator
// — the browser's own menu popped open over the page mid-login. Verified against
// the container: `xdotool key alt+e` adds a menu window, bare Alt does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, fireWindow } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('desktop-mac');

test('⌥ chords never reach the remote from the canvas (no app-menu accelerator)', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  for (const key of ['Dead', 'e', 'f', 'd', 'ArrowLeft']) {
    const e = fireWindow('keydown', { key, keyCode: 69, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false });
    assert.equal(e.propagationStopped, true, `noVNC must not forward ⌥${key} raw`);
    assert.equal(e.defaultPrevented, false, 'preventDefault would cancel the dead-key composition');
  }
  assert.deepEqual(rfb.keys, []);
});

test('bare ⌥ press and release are invisible to the remote', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  const down = fireWindow('keydown', { key: 'Alt', keyCode: 18, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false });
  // altKey already reads false on the release of ⌥ itself.
  const up = fireWindow('keyup', { key: 'Alt', keyCode: 18, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
  assert.equal(down.propagationStopped, true);
  assert.equal(up.propagationStopped, true, 'a lone release would be a keysym noVNC never pressed');
  assert.deepEqual(rfb.keys, []);
});

test('⌥ with the proxy focused is composition, not a chord', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  // ⌥a on a US layout produces å — it must go out as text, not Alt+å.
  fire(proxy, 'keydown', { key: 'å', keyCode: 65, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false });
  assert.deepEqual(rfb.keys, []);
  proxy.value = 'å';
  fire(proxy, 'input', {});
  assert.deepEqual(rfb.tapped(), keysymsFor('å'));
});

test('⌃ and ⌘ chords are untouched by the ⌥ guard', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  fireWindow('keydown', { key: 'a', keyCode: 65, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
  assert.deepEqual(rfb.chords(), [[0xffe3, true], [0x61, true], [0x61, false], [0xffe3, false]]);
});

test('⌃⌥ and ⌘⌥ are denied with other non-editing command chords', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const e = fire(proxy, 'keydown', { key: 'ArrowLeft', keyCode: 37, ctrlKey: true, altKey: true, metaKey: false, shiftKey: false });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(rfb.keys, []);
});
