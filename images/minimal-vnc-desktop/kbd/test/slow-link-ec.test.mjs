// slow-link-ec.test.mjs — characterization: commit-only composition on a slow
// link (EC path). Separate file because seeding the shared latency EMA would
// flip commitOnly() for every other test in the same process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, fireEC } from './stub-dom.mjs';
import { createMockRfb, keysymsFor } from './mock-rfb.mjs';

installGlobals('android-ec');

// Seed the link-latency EMA ABOVE the 700ms commit-only threshold. Same module
// instance the core reads (child modules are not cache-busted).
const { noteRtt, linkLatency } = await import('../latency.js');
noteRtt(2000);
assert.ok(linkLatency() > 700, 'latency seed failed');

test('slow link: composing steps are withheld; compositionend sends the committed text once', async () => {
  const v = await freshViewer(createMockRfb);
  const { rfb } = v;
  const ec = v.proxy.editContext;

  fireEC(ec, 'compositionstart', {});
  ec.text = '가';
  fireEC(ec, 'textupdate', { text: '가', updateRangeStart: 0, updateRangeEnd: 0 });
  ec.text = '가나';
  fireEC(ec, 'textupdate', { text: '나', updateRangeStart: 1, updateRangeEnd: 1 });
  assert.deepEqual(rfb.tapped(), []);      // every marked-text step withheld
  assert.equal(ec.text, '가나');            // buffer accumulates (no reset mid-composition)

  fireEC(ec, 'compositionend', {});
  assert.deepEqual(rfb.tapped(), keysymsFor('가나')); // whole word flushed once
  assert.equal(ec.text, '');
});
