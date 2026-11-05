// content-viewport-meta.test.mjs — the no-viewport answer fit-to-width keys on.
//
// declaredLayoutViewportWidth is lifted out of the shipped content.js and run
// against a stub document. A page still parsing <head> on a slow network has no
// meta yet; answering "no viewport" from that state put responsive pages into the
// 980px desktop fit, so the answer must stay unknown until <body> exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_SRC } from './content-offset.mjs';

function balancedBody(src, start) {
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const start = CONTENT_SRC.indexOf('function declaredLayoutViewportWidth(');
assert.ok(start > 0, 'content.js defines declaredLayoutViewportWidth');
const FN_SRC = balancedBody(CONTENT_SRC, start);

function declared({ metas = [], body = true }) {
  const document = {
    body: body ? {} : null,
    getElementsByTagName: () => metas.map(([name, content]) => ({ name, getAttribute: () => content })),
  };
  const meta = { declaredLayoutWidth: (c) => (/device-width|initial-scale/.test(c) ? null : 1024) };
  return new Function('document', 'globalThis', FN_SRC + '\nreturn declaredLayoutViewportWidth();')(
    document, { __POPCORN_VIEWPORT_META__: meta });
}

test('a page still parsing <head> has no answer yet', () => {
  assert.equal(declared({ body: false }), undefined);
});

test('a parsed page without a viewport meta needs the desktop fallback', () => {
  assert.equal(declared({}), 980);
});

test('a viewport meta is read even before <body> exists', () => {
  assert.equal(declared({ body: false, metas: [['viewport', 'width=device-width, initial-scale=1']] }), null);
  assert.equal(declared({ body: false, metas: [['viewport', 'width=1024']] }), 1024);
});
