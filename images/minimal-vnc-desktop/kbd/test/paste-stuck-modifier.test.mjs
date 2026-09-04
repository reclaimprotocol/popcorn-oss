// paste-stuck-modifier.test.mjs — a modifier held on the REMOTE must never turn
// injected text into a chord.
//
// Reported from a Linux viewer: pasting into a login form popped Chromium's
// "Bookmark all tabs" dialog. Nothing sends D. But injected text is one bare
// keysym per code point, and X derives the Shift from the keysym level — so a
// capital D (0x44) arriving while Control is down IS Ctrl+Shift+D. The Ctrl the
// user was physically holding to paste is the one that leaks: on the canvas-focused
// path noVNC forwards the bare Ctrl keydown (installDesktopChords intercepts the
// letter, never the modifier), and Ctrl+V is only the Linux/Windows paste chord —
// macOS sends ⌘, which the remote browser ignores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, pushSignal } from './stub-dom.mjs';
import { createMockRfb, keysymsFor, MOD_RELEASES } from './mock-rfb.mjs';

installGlobals('desktop'); // Windows/Linux UA — where the paste chord is Ctrl+V

const CONTROL_L = 0xffe3;

test('a paste releases every remote modifier before injecting anything', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  pushSignal({ editable: true, focusKey: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: {}, sync: {} });
  rfb.clearKeys();
  fire(proxy, 'paste', { clipboardData: { getData: () => 'Dpassword' } });
  assert.deepEqual(rfb.chords(), MOD_RELEASES, 'the sweep must precede the text');
  // The sweep lands before the first character, so the capital D cannot be read
  // as Ctrl+Shift+D.
  assert.ok(rfb.keys.findIndex((k) => k.down === false && k.keysym === CONTROL_L) <
            rfb.keys.findIndex((k) => k.down === undefined));
  assert.deepEqual(rfb.tapped(), keysymsFor('Dpassword'));
});

test('the staged Ctrl+V path sweeps first too', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  // No known focused field -> stage on the remote clipboard + one Ctrl+V.
  fire(proxy, 'paste', { clipboardData: { getData: () => 'Bookmark all tabs?' } });
  assert.deepEqual(rfb.chords(),
    [...MOD_RELEASES, [CONTROL_L, true], [0x76, true], [0x76, false], [CONTROL_L, false]]);
});

// The releases used to sit at the end of the same try block as the presses, so a
// send that threw mid-chord latched Control on the remote for the rest of the
// session — after which every capital letter typed was an accelerator.
test('a throw mid-chord still releases Control', async () => {
  const { rfb, proxy } = await freshViewer(createMockRfb);
  const realSendKey = rfb.sendKey;
  let calls = 0;
  rfb.sendKey = function (keysym, code, down) {
    realSendKey.call(this, keysym, code, down);
    // Blow up on the 'v' press, after Control is already down.
    if (keysym === 0x76 && down === true) { calls++; throw new Error('socket gone'); }
  };
  fire(proxy, 'paste', { clipboardData: { getData: () => 'x'.repeat(40) } });
  rfb.sendKey = realSendKey;
  assert.equal(calls, 1, 'the throw must actually have fired');
  const chords = rfb.chords();
  assert.deepEqual(chords[chords.length - 1], [CONTROL_L, false], 'Control must not stay latched');
});

// Typing has the same exposure as pasting: the canvas held focus until the /kbd
// signal arrived, so a modifier the user is still holding is down on the remote
// when the first character goes out. Sweep at the handoff, once per focus.
test('taking the keyboard from the canvas sweeps the remote modifiers', async () => {
  const { rfb } = await freshViewer(createMockRfb);
  rfb.clearKeys();
  pushSignal({ editable: true, focusKey: 'f9', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: {}, sync: {} });
  assert.deepEqual(rfb.chords(), MOD_RELEASES);
});
