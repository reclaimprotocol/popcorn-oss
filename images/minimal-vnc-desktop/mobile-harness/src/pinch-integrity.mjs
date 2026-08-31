import pixelmatch from 'pixelmatch';

function parseColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value));
  if (!match) throw new Error(`Expected a six-digit hex color, got ${value}`);
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

export function colorGeometry(png, color, tolerance = 20) {
  const target = parseColor(color);
  let pixels = 0;
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      if (
        Math.abs(png.data[offset] - target[0]) <= tolerance
        && Math.abs(png.data[offset + 1] - target[1]) <= tolerance
        && Math.abs(png.data[offset + 2] - target[2]) <= tolerance
        && png.data[offset + 3] >= 200
      ) {
        pixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        sumX += x;
        sumY += y;
      }
    }
  }
  if (!pixels) return null;
  return {
    pixels,
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centerX: sumX / pixels,
    centerY: sumY / pixels,
  };
}

export function normalizedRegionChange(fromImage, toImage, region, pixelThreshold = 0.15) {
  if (fromImage.width !== toImage.width || fromImage.height !== toImage.height) {
    throw new Error('Stable-region images must have matching dimensions');
  }
  const x = Math.max(0, Math.floor(Number(region.x ?? 0) * fromImage.width));
  const y = Math.max(0, Math.floor(Number(region.y ?? 0) * fromImage.height));
  const width = Math.min(fromImage.width - x, Math.ceil(Number(region.width ?? 1) * fromImage.width));
  const height = Math.min(fromImage.height - y, Math.ceil(Number(region.height ?? 1) * fromImage.height));
  if (width <= 0 || height <= 0) throw new Error('Stable region must have positive dimensions');
  const from = Buffer.alloc(width * height * 4);
  const to = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * fromImage.width + x) * 4;
    const sourceEnd = sourceStart + width * 4;
    fromImage.data.copy(from, row * width * 4, sourceStart, sourceEnd);
    toImage.data.copy(to, row * width * 4, sourceStart, sourceEnd);
  }
  const changedPixels = pixelmatch(from, to, null, width, height, {
    threshold: pixelThreshold,
    includeAA: false,
  });
  return { x, y, width, height, changedPixels, changedPixelRatio: changedPixels / (width * height) };
}
