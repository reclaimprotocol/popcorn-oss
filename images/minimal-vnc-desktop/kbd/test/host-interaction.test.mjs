// host-interaction.test.mjs — characterization: the POPCORN_INTERACTION stream an
// embedding host uses for its own product analytics.
//
// A host that used to drive input itself had one choke point where every user
// action passed through, and derived a whole funnel from it (first interaction,
// started typing, form submitted, session abandonment). With input owned in here,
// that choke point is ours: these tests pin the vocabulary and the counting, and —
// most importantly — that typed TEXT never appears in the messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fire, fireDoc, makeScreen, parentMessages } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

// magnify=1 so the layer owns touch (TOUCH_INPUT) — that is the configuration the
// tap path runs in, and the one an embedding host deploys.
installGlobals('ios', { search: '?magnify=1' });

function interactions() {
  return parentMessages.filter((m) => m.type === 'POPCORN_INTERACTION');
}

test('typing reports one char per send, not per code point', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  parentMessages.length = 0;
  // Six code points in ONE input event: the CDP path a host may have mapped
  // before (Input.insertText) counted that once, so a paste or IME batch must not
  // inflate the host's typing metrics.
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'hello!' });
  const chars = interactions().filter((m) => m.kind === 'char');
  assert.equal(chars.length, 1, 'one char report for the batch');
});

test('interaction reports never carry typed text', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  parentMessages.length = 0;
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'sekrit-password' });
  const blob = JSON.stringify(interactions());
  assert.ok(!/sekrit/.test(blob), 'no typed text in the interaction stream');
  assert.deepEqual(
    interactions().map((m) => m.kind),
    ['char'],
    'kind only, no payload',
  );
});

test('a named key reports as special with the key NAME', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'ab' });
  parentMessages.length = 0;
  fire(proxy, 'beforeinput', { inputType: 'deleteContentBackward' });
  const specials = interactions().filter((m) => m.kind === 'special');
  assert.equal(specials.length, 1);
  assert.equal(specials[0].detail, 'Backspace');
});

test('a printable key can never be reported as a special detail', async () => {
  const { proxy } = await freshViewer(createMockRfb);
  parentMessages.length = 0;
  fire(proxy, 'beforeinput', { inputType: 'insertText', data: 'x' });
  // safeKeyName redacts single characters, so even a mis-routed printable key
  // surfaces as 'chr' rather than the character itself.
  for (const m of interactions()) {
    assert.notEqual(m.detail, 'x');
  }
});

// The tap -> 'click' report lives in host-interaction-tap.test.mjs: document-level
// touch handlers accumulate across freshViewer() calls (only installGlobals resets
// them), so a gesture test has to be the first viewer in its process.
