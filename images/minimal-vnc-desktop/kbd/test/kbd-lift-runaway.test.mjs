// kbd-lift-runaway.test.mjs — characterization: the field-lift must never chase
// a field OUT of the framebuffer. Own file: the lift is re-applied by every
// core a visualViewport resize reaches, so this scenario needs a process where
// no earlier viewer holds a competing field rect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireViewport, makeScreen, pushSignal,
  setVisualViewportHeight,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

function translateY(screen) {
  const m = /translate\((-?[\d.]+)px,(-?[\d.]+)px\)/.exec(screen.style.transform || '');
  return m ? parseFloat(m[2]) : 0;
}

test('a field scrolled below the remote viewport gets NO lift (black-screen runaway)', async () => {
  globalThis.window.innerHeight = 844;
  setVisualViewportHeight(844);
  await freshViewer(createMockRfb);
  const screen = makeScreen();
  setVisualViewportHeight(544);
  fireViewport('resize');
  // Reproduces the on-device runaway: scrolling the remote while its field
  // stays focused re-reports the rect UNCLIPPED below the viewport (y > vh);
  // the lift chased it (observed 257->479->633->640 on a 689px canvas, vb
  // pinned at 406) and shoved the whole stream off the top — a black screen.
  // A field that is not in the framebuffer cannot be revealed by any lift.
  pushSignal({
    editable: true, focusKey: 'b3', rect: { x: 20, y: 990, w: 200, h: 40 },
    rects: [{ x: 20, y: 990, w: 200, h: 40 }], vw: 390, vh: 844, sb: 0,
  });
  assert.equal(translateY(screen), 0, 'no lift toward a field outside the framebuffer');

  // Scrolled back into view near the bottom edge: the lift resumes, but never
  // past the occlusion (300) plus the 16px margin — the pan-budget invariant.
  pushSignal({
    editable: true, focusKey: 'b3', rect: { x: 20, y: 810, w: 200, h: 40 },
    rects: [{ x: 20, y: 810, w: 200, h: 40 }], vw: 390, vh: 844, sb: 0,
  });
  const ty = translateY(screen);
  assert.ok(ty < 0 && ty >= -316, 'lift resumed but capped at occlusion+margin, got ' + ty);

  setVisualViewportHeight(844);
  fireViewport('resize');
});
