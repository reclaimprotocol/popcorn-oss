// fbtarget.test.mjs — the framebuffer/CDP size agreement (kbd/fbtarget.js).
//
// This is the invariant that makes supersampling possible at all. The framebuffer
// size (noVNC SetDesktopSize) and the CDP render size (/emulate) are computed in
// different files, and if they disagree Chromium renders into a surface bigger than
// the framebuffer and the right/bottom edge is silently CROPPED. That is exactly
// what the old "deviceScaleFactor is ALWAYS 1 — verified, it crops" note in fit.js
// recorded: the conclusion was that DSF must stay 1, but the actual cause was that
// only one of the two numbers had been raised.
//
// So the property under test is `w === cssW * scale` for every input, including the
// awkward ones (the kiosk cap biting, the FB_MAX ceiling, odd viewport sizes). If it
// holds, a DSF > 1 renders exactly into the framebuffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbTarget, setFbScale, FB_MAX } from '../fbtarget.js';

const env = (over) => Object.assign({ __pcnFbCap: null, __pcnFill: false }, over || {});

test('at 1x it is the identity the viewer has always had', () => {
  setFbScale(1);
  const t = fbTarget(411, 732, env());
  assert.deepEqual(t, { w: 411, h: 732, cssW: 411, cssH: 732, scale: 1 });
});

test('at 2x the framebuffer doubles and the CSS layout does NOT', () => {
  // The whole point: the page still lays out as a 411px mobile viewport (same
  // reflow, same media queries, no reload) while the raster carries 4x the pixels.
  const t = fbTarget(411, 732, env({ __pcnFbScale: 2 }));
  assert.equal(t.cssW, 411, 'layout width unchanged');
  assert.equal(t.cssH, 732, 'layout height unchanged');
  assert.equal(t.w, 822);
  assert.equal(t.h, 1464);
  assert.equal(t.scale, 2);
});

test('w === cssW * scale for every shape — the anti-crop invariant', () => {
  const sizes = [[411, 732], [390, 844], [360, 640], [1179, 2556], [1, 1], [1367, 769]];
  const caps = [null, { w: 1280, h: 1024 }, { w: 1920, h: 1080 }, { w: 4096, h: 4096 }];
  for (const k of [1, 2, 3]) {
    for (const [w, h] of sizes) {
      for (const cap of caps) {
        for (const fill of [false, true]) {
          const t = fbTarget(w, h, env({ __pcnFbCap: cap, __pcnFill: fill, __pcnFbScale: k }));
          assert.equal(t.w, t.cssW * t.scale,
            `w=${t.w} cssW=${t.cssW} scale=${t.scale} (in ${w}x${h} cap=${JSON.stringify(cap)} fill=${fill} k=${k})`);
          assert.equal(t.h, t.cssH * t.scale, 'height agrees too');
          assert.ok(t.w <= FB_MAX && t.h <= FB_MAX, 'never asks past the proxy clamp');
          assert.ok(Number.isInteger(t.w) && Number.isInteger(t.h), 'whole pixels only');
        }
      }
    }
  }
});

test('the factor is DROPPED rather than exceeding the proxy clamp', () => {
  // A big tablet viewport at 3x would be 4137px wide — past FB_MAX. Stepping the
  // factor down keeps the agreement; clamping the framebuffer instead would break
  // it, and a broken agreement is a cropped page.
  const t = fbTarget(1379, 1000, env({ __pcnFbScale: 3 }));
  assert.ok(t.scale < 3, 'stepped down (scale=' + t.scale + ')');
  assert.equal(t.w, t.cssW * t.scale);
  assert.ok(t.w <= FB_MAX);
});

test('a fractional factor is rounded, never applied as a fraction', () => {
  // 1.5 would put cssW * k on a half pixel, and whichever side rounds first wins.
  const t = fbTarget(411, 732, env({ __pcnFbScale: 1.5 }));
  assert.ok(Number.isInteger(t.scale));
  assert.equal(t.w, t.cssW * t.scale);
});

test('the kiosk cap still clamps the CSS size (page zoom inflation)', () => {
  // The cap exists because browser page zoom made the requested rect enormous: a
  // 1728px window at 25% zoom reports 6912 CSS px. It bounds the LAYOUT size; the
  // factor then multiplies whatever survived.
  const t = fbTarget(6912, 3464, env({ __pcnFbCap: { w: 1280, h: 1024 }, __pcnFbScale: 2 }));
  assert.equal(t.cssW, 1280);
  assert.equal(t.cssH, 1024);
  assert.equal(t.w, 2560);
  assert.equal(t.h, 2048);
});

test('?fill=1 keeps clamping proportionally, and still agrees', () => {
  const t = fbTarget(2560, 1440, env({ __pcnFbCap: { w: 1280, h: 1024 }, __pcnFill: true }));
  assert.equal(t.scale, 1);
  assert.equal(t.w, t.cssW);
  // Proportional, not per-axis: the aspect of the request is preserved.
  assert.ok(Math.abs((t.cssW / t.cssH) - (2560 / 1440)) < 0.02, 'window aspect preserved');
});

test('setFbScale is the fallback when the page publishes no factor', () => {
  setFbScale(2);
  const t = fbTarget(411, 732, { __pcnFbCap: null, __pcnFill: false });
  assert.equal(t.scale, 2);
  setFbScale(1);
  assert.equal(fbTarget(411, 732, {}).scale, 1);
});
