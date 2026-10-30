// content-overflow.test.mjs — the page-width measurements fit-to-width keys on.
//
// sw (docScrollWidth) and ol/olw/cr (overflowStats) are lifted out of the shipped
// content.js and run against a stub page, so these cases exercise the real code.
// The geometry is measured from a live mobile layout: a 310px drawer parked to the
// left of a 412px view, which the page scrolls past (scrollX=310) so the view
// fills the screen, plus a fixed backdrop parked wholly off-screen. At tablet
// widths the same page's layout container runs 200px past the screen while all of
// its text and controls fit.
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

function slice(from, lastFn) {
  const start = CONTENT_SRC.indexOf(from);
  assert.ok(start > 0, `content.js contains ${from}`);
  const fn = CONTENT_SRC.indexOf(`function ${lastFn}(`, start);
  assert.ok(fn > 0, `content.js defines ${lastFn}`);
  const body = balancedBody(CONTENT_SRC, fn);
  return CONTENT_SRC.slice(start, fn) + body;
}

const WIDTH_SRC = slice('let framePainted', 'pageScrollX');
const OVERFLOW_SRC = slice('let overflowDirty', 'overflowStats');

function el({ left, width, height = 20, tag = 'div', text = '', position = 'static' }) {
  return {
    _position: position,
    children: [],
    textContent: text,
    matches: (sel) => sel.split(',').includes(tag),
    getBoundingClientRect: () => ({ left, right: left + width, width, height }),
  };
}

function page({ scrollX = 0, scrollWidth = 0, clientWidth = 0, elements = [] }) {
  let frame = null;
  const window = { scrollX, innerWidth: clientWidth };
  const document = {
    documentElement: { scrollWidth, clientWidth },
    body: { scrollWidth },
    querySelectorAll: () => elements,
  };
  const api = new Function(
    'window', 'document', 'getComputedStyle', 'requestAnimationFrame', 'scheduleReport',
    WIDTH_SRC + '\n' + OVERFLOW_SRC + '\nreturn { docScrollWidth, overflowStats };',
  )(
    window, document,
    (e) => ({ position: e._position }),
    (cb) => { frame = cb; },
    () => {},
  );
  return { ...api, paint: () => frame && frame() };
}

test('sw waits for the first frame, when the page has applied its own scroll', () => {
  const p = page({ scrollX: 310, scrollWidth: 722, clientWidth: 412 });
  assert.equal(p.docScrollWidth(), 0, 'no width before a frame is rendered');
  p.paint();
  assert.equal(p.docScrollWidth(), 412, 'only what lies right of the scrolled view counts');
});

test('sw is unchanged for a page whose content runs past the right edge', () => {
  const p = page({
    scrollWidth: 1232, clientWidth: 390,
    elements: [el({ left: 8, width: 1200, text: 'a fixed-width table row' })],
  });
  p.paint();
  assert.equal(p.docScrollWidth(), 1232);
});

test('a container wider than the screen fits when its content does', () => {
  const p = page({
    scrollWidth: 1200, clientWidth: 1000,
    elements: [
      el({ left: 0, width: 1200, height: 768 }),                        // layout container
      el({ left: 200, width: 1000, height: 768 }),                      // panel, empty end off-screen
      el({ left: 864, width: 120, tag: 'button', text: 'Sign up' }),    // rightmost control
      el({ left: 1100, width: 300, tag: 'button', position: 'fixed' }), // parked past the edge
    ],
  });
  p.paint();
  assert.equal(p.docScrollWidth(), 1000);
});

test('media past the right edge is content', () => {
  const p = page({
    scrollWidth: 1400, clientWidth: 390,
    elements: [el({ left: 0, width: 1400, height: 300, tag: 'img' })],
  });
  p.paint();
  assert.equal(p.docScrollWidth(), 1400);
});

test('a drawer the page scrolled past and its off-screen backdrop are not clipped content', () => {
  const p = page({
    scrollX: 310,
    elements: [
      el({ left: -310, width: 722 }),                                     // page row, from x=0
      el({ left: -286, width: 96, tag: 'a', text: 'New chat' }),          // drawer link, reachable
      el({ left: -310, width: 310, position: 'fixed', text: 'Images' }),  // fixed drawer, wholly off
      el({ left: -412, width: 412, tag: 'button', position: 'fixed' }),   // backdrop, wholly off
      el({ left: 325, width: 71, tag: 'button', text: 'Log in' }),
    ],
  });
  const { ol, olw } = p.overflowStats();
  assert.ok(ol === 0 && olw === 0, `ol=${ol} olw=${olw}`); // -0 counts as none
});

test('content cut by the left edge is still reported', () => {
  const p = page({
    elements: [
      el({ left: -48, width: 392, tag: 'input' }),           // form row sliced at the edge
      el({ left: -34, width: 60 }),                          // decorative, also sliced
      el({ left: -9999, width: 120, tag: 'a', text: 'Skip to content' }), // parked off-screen
    ],
  });
  const { ol, olw } = p.overflowStats();
  assert.equal(ol, 48);
  assert.equal(olw, 392);
});
