// content-offset.mjs — run content.js's cross-frame rect arithmetic in a test.
//
// content.js is one IIFE with no exports, and standing the whole thing up needs a
// page, a chrome.runtime and a frame tree. The part worth testing here is small
// and pure: px() and offsetState(), which shift a frame's rects into top-window
// coords. Lift those two out of the shipped source so the test exercises the real
// code rather than a transcription of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_SRC = readFileSync(
  join(here, '..', '..', 'extensions', 'proxy', 'content.js'), 'utf8');

function balancedBody(src, start) {
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

export function loadOffsetState() {
  const pxLine = CONTENT_SRC.match(/^\s*const px = .*$/m);
  assert.ok(pxLine, 'content.js defines px');
  const start = CONTENT_SRC.indexOf('function offsetState(');
  assert.ok(start > 0, 'content.js defines offsetState');
  const body = balancedBody(CONTENT_SRC, start);
  assert.ok(body, 'offsetState body is balanced');
  return new Function(pxLine[0] + '\n' + body + '\nreturn offsetState;')();
}

// A host app's web view loads our page, that page embeds a partner frame at
// (0, 96), and the partner frame embeds the form holding the DOB input at
// (16, 140). content.js in the innermost frame walks that chain and emits the sum.
export const CHAIN = { x: 16, y: 236 };

export function nestedState() {
  return {
    editable: false,
    vw: 390,
    vh: 844,
    rects: [{ x: 24, y: 300, w: 342, h: 56 }],
    selects: [{ k: 'sel:1', r: { x: 24, y: 380, w: 342, h: 56 }, s: 0, o: [] }],
    pickers: [{
      k: 'dob:1', t: 'date', r: { x: 24, y: 220, w: 342, h: 56 },
      v: '1994-03-17', min: '1900-01-01', max: '2008-12-31', step: '1', req: true, a: 'Date of birth',
    }],
  };
}
