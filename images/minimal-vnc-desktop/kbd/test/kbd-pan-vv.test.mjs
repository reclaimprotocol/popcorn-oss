// kbd-pan-vv.test.mjs — characterization: the keyboard-pan budget on the
// visualViewport detector path (Android top-level without a VirtualKeyboard
// stub), and its two hard exclusions:
//
//   * the field-lift and the user pan share ONE budget — the occlusion. A field
//     near the page bottom is already lifted ~the keyboard height, so the user
//     gets only the remainder; together they may bring the content bottom to
//     the keyboard's top edge and never past it (no dead #111 strip above the
//     keys);
//   * layout-resize mode (Firefox Android / adjustResize WebView) gets NO pan
//     extension and NO gesture change — the layout already reflowed to the
//     shrunk height, so a local pan would double-shift into blank space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobals, freshViewer, fireDoc, fireWindow, fireViewport, makeScreen,
  pushSignal, webSockets, setVisualViewportHeight,
} from './stub-dom.mjs';
import { createMockRfb } from './mock-rfb.mjs';

installGlobals('android-input', { search: '?magnify=1' });

function touches(...pts) {
  return pts.map(([x, y]) => ({ clientX: x, clientY: y }));
}
function inputSock() {
  return webSockets.filter((s) => s.url.endsWith('/input')).at(-1);
}
function sentTypes(sock, from) {
  return sock.sent.slice(from).map((m) => JSON.parse(m).t);
}
function translateY(screen) {
  const m = /translate\((-?[\d.]+)px,(-?[\d.]+)px\)/.exec(screen.style.transform || '');
  return m ? parseFloat(m[2]) : 0;
}

test('the pan budget is the occlusion MINUS the lift already applied', async () => {
  await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  // Keyboard via visualViewport shrink: 844 -> 544, occlusion 300.
  setVisualViewportHeight(544);
  fireViewport('resize');
  // A field near the page bottom: the lift raises it above the keys —
  // fieldBottom 740 against limit 544-16 = 212px of lift.
  pushSignal({
    editable: true, focusKey: 'b1', rect: { x: 20, y: 700, w: 200, h: 40 },
    rects: [{ x: 20, y: 700, w: 200, h: 40 }], vw: 390, vh: 844, sb: 0,
  });
  assert.equal(translateY(screen), -212, 'the lift already revealed part of the occluded band');

  const sock = inputSock();
  const before = sock.sent.length;
  fireDoc('touchstart', { touches: touches([200, 600]), changedTouches: touches([200, 600]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 592]), changedTouches: touches([200, 592]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 392]), changedTouches: touches([200, 392]), target: canvas });

  // Requested 200px of pan; only 300-212=88 remain before the content bottom
  // meets the keyboard top. Composed translate = pan(88) + lift(212) = 300.
  assert.equal(translateY(screen), -300, 'pan + lift never exceed the occlusion');
  assert.ok(sentTypes(sock, before).includes('start'), 'the overrun handed off to the remote');
  fireDoc('touchend', { touches: [], changedTouches: touches([200, 392]), target: canvas });

  // VV grows back -> dismiss -> lift AND extension collapse together.
  setVisualViewportHeight(844);
  fireViewport('resize');
  assert.equal(translateY(screen), 0, 'dismissal returns the view to rest');
});

test('layout-resize mode gets no pan extension — drags keep forwarding to the remote', async () => {
  globalThis.window.innerHeight = 844;
  setVisualViewportHeight(844);
  const { proxy } = await freshViewer(createMockRfb);
  const screen = makeScreen();
  const canvas = screen.querySelector('canvas');
  // Firefox-style keyboard: layout viewport shrinks WITH the visual viewport.
  globalThis.window.innerHeight = 644;
  setVisualViewportHeight(644);
  proxy.focus();
  fireWindow('resize');
  pushSignal({ editable: true, focusKey: 'b2', rect: { x: 20, y: 100, w: 200, h: 40 }, vw: 390, vh: 844, sb: 0 });

  const sock = inputSock();
  const before = sock.sent.length;
  fireDoc('touchstart', { touches: touches([200, 600]), changedTouches: touches([200, 600]), target: canvas });
  fireDoc('touchmove', { touches: touches([200, 560]), changedTouches: touches([200, 560]), target: canvas });

  assert.ok(sentTypes(sock, before).includes('start'), 'the drag forwarded to the remote immediately');
  assert.equal(translateY(screen), 0, 'no local transform: the layout already made room');

  fireDoc('touchend', { touches: [], changedTouches: touches([200, 560]), target: canvas });
  globalThis.window.innerHeight = 844;
  setVisualViewportHeight(844);
  fireWindow('resize');
});
