import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, freshViewer, pushSignal } from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('desktop', { search: '?kbddebug=1' });
globalThis.console = Object.assign({}, globalThis.console, { log() {} });
const { dbg } = await import('../diag.js');
const fields = () => globalThis.__pcnKbdLog().split('\n').filter(line => / fields /.test(line));

test('idle field diagnostics distinguish unknown, empty and populated geometry without content', async () => {
  await freshViewer(createMockRfb);
  pushSignal({ editable: false });
  pushSignal({ editable: false, rects: [], vw: 1000, vh: 800 });
  const signal = { editable: false, rects: [{ x: 10, y: 20, w: 100, h: 40 }], vw: 1000, vh: 800 };
  pushSignal(signal);
  const count = fields().length;
  for (let i = 0; i < 100; i++) pushSignal(signal);
  assert.equal(fields().length, count, 'identical heartbeats add no log lines');
  const lines = fields().join('\n');
  assert.match(lines, /editable=0 focus=0 rects=unknown viewport=0/);
  assert.match(lines, /editable=0 focus=0 rects=0 viewport=1/);
  assert.match(lines, /editable=0 focus=0 rects=1 viewport=1/);
  assert.doesNotMatch(lines, /10,20|x=|y=/);
});

test('new diagnostics project flags only and cap changes per viewer setup', async () => {
  await freshViewer(createMockRfb);
  // Flush the 200-line debug ring so this assertion only sees this viewer.
  for (let i = 0; i < 200; i++) dbg('test marker');
  for (let i = 0; i < 80; i++) {
    pushSignal({ editable: false, focusKey: 'PRIVATE_FIELD',
      rects: Array.from({ length: i }, () => ({ x: 1, y: 1, w: 1, h: 1 })),
      vw: 1000, vh: 800, blind: true, rtrunc: true,
      hints: { placeholder: 'PRIVATE_HINT' }, sync: { val: 'PRIVATE_VALUE' } });
  }
  const lines = fields();
  assert.equal(lines.length, 32);
  assert.match(lines.at(-1), /limit=1$/);
  assert.match(lines[0], /focus=1.*blind=1 truncated=1/);
  assert.doesNotMatch(lines.join('\n'), /PRIVATE_/);
});
