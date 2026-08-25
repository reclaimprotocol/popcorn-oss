import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';

import { colorGeometry, normalizedRegionChange } from '../src/pinch-integrity.mjs';

function image(width = 20, height = 20, fill = [255, 255, 255, 255]) {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) png.data.set(fill, offset);
  return png;
}

function rectangle(png, x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) png.data.set(color, (py * png.width + px) * 4);
  }
}

test('color geometry measures a framebuffer-visible zoom target', () => {
  const png = image();
  rectangle(png, 5, 6, 4, 3, [0, 208, 132, 255]);
  assert.deepEqual(colorGeometry(png, '#00d084', 0), {
    pixels: 12,
    x: 5,
    y: 6,
    width: 4,
    height: 3,
    centerX: 6.5,
    centerY: 7,
  });
});

test('stable region ignores changes outside the configured browser-chrome crop', () => {
  const before = image();
  const after = image();
  rectangle(after, 0, 0, 20, 10, [0, 0, 0, 255]);
  const stable = normalizedRegionChange(before, after, { x: 0, y: 0.75, width: 1, height: 0.25 }, 0.1);
  assert.equal(stable.changedPixels, 0);
  assert.equal(stable.changedPixelRatio, 0);
});
