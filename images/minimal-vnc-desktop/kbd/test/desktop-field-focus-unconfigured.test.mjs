// An embed without ?parentOrigin= never receives field kinds: outbound geometry
// stays '*'-compatible, but field focus is only for a pinned embedder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, pushSignal, parentMessages } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('desktop', { embedded: true });

test('no POPCORN_FIELD_FOCUS without a configured parent origin', async () => {
  await freshViewer(createMockRfb);
  parentMessages.length = 0;
  pushSignal({ editable: true, focusKey: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 },
    hints: { type: 'password' }, sync: { sensitive: true } });
  assert.equal(parentMessages.filter((m) => m.type === 'POPCORN_FIELD_FOCUS').length, 0);
});
