// window-fractions.mjs — swipe endpoints expressed as fractions of the native window.
//
// A scroll does not care where it starts, only that it starts on the scrollable area
// and travels far enough. Literal coordinates encode both the device AND the surface:
// `fromY: 500` was calibrated on a 844pt iOS window, so on a 2400px Android
// framebuffer it lands in the top fifth of the screen, and in a browser it can land on
// the URL bar, where the page never sees the gesture at all. That is why 40 of the
// sweep's scroll swipes needed per-platform overrides and still only ran on one
// surface.
//
// A fraction of the window has neither problem: 0.65 is the same place on every device
// and every surface. Keep fractions inside the middle band (roughly 0.2..0.8) so the
// endpoints stay clear of browser chrome at the top and the gesture-nav strip at the
// bottom.
//
// Absolute values still win when present, so existing cases are untouched.

const PAIRS = [
  ['fromX', 'fromXFraction', 'width'],
  ['toX', 'toXFraction', 'width'],
  ['fromY', 'fromYFraction', 'height'],
  ['toY', 'toYFraction', 'height'],
];

export function resolveWindowFractions(action, rect) {
  const resolved = { ...action };
  for (const [absolute, fraction, dimension] of PAIRS) {
    const value = action?.[fraction];
    if (value === undefined) continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      throw new Error(`${fraction}=${value} must be a fraction between 0 and 1`);
    }
    const extent = Number(rect?.[dimension]);
    if (!Number.isFinite(extent) || extent <= 0) {
      throw new Error(`${fraction} needs a native window ${dimension}`);
    }
    resolved[absolute] = Math.round(number * extent);
    delete resolved[fraction];
  }
  return resolved;
}

// True when the action leaves the swipe geometry to the window, so the caller can skip
// the coordinate scale that only applies to hand-calibrated numbers.
export function usesWindowFractions(action) {
  return PAIRS.some(([, fraction]) => action?.[fraction] !== undefined);
}
