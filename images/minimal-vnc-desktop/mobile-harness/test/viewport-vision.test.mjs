import assert from 'node:assert/strict';
import test from 'node:test';

import { compareTextGeometry } from '../src/viewport-vision.mjs';

function observation(text, height, width = 0.2) {
  return { text, confidence: 0.99, x: 0.1, y: 0.5, width, height };
}

test('vision geometry detects a uniformly shrunken desktop viewport', () => {
  const baseline = [
    observation('Viewport regression title', 0.04),
    observation('Shared field label', 0.03),
    observation('Visible action button', 0.035),
  ];
  const candidate = [
    observation('Viewport regression title', 0.016),
    observation('Shared field label', 0.012),
    observation('Visible action button', 0.014),
  ];

  const result = compareTextGeometry(baseline, candidate);

  assert.equal(result.passed, false);
  assert.equal(result.matchedTextCount, 3);
  assert.ok(result.medianTextHeightScale < 0.5);
});

test('vision geometry accepts modest engine-specific text scaling', () => {
  const baseline = [
    observation('Viewport regression title', 0.04),
    observation('Shared field label', 0.03),
    observation('Visible action button', 0.035),
  ];
  const candidate = [
    observation('Viewport regression title', 0.036),
    observation('Shared field label', 0.027),
    observation('Visible action button', 0.0315),
  ];

  const result = compareTextGeometry(baseline, candidate);

  assert.equal(result.passed, true);
  assert.ok(Math.abs(result.medianTextHeightScale - 0.9) < 1e-9);
});
