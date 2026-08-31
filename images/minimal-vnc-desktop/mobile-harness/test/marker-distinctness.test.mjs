// marker-distinctness.test.mjs — a case's phase markers must be tellable apart.
//
// waitForColor matches when EVERY channel is within `tolerance`, so two markers
// that look different to a person can still be the same marker to the runner. That
// is not a cosmetic problem: mixed-input-return-cycle waited for its message-typed
// marker #3f6212 while the telephone-typed marker #4d7c0f (R14 G26 B3 away) was
// already on screen, so the case walked past a step that had plainly failed — the
// textarea never received its text — and failed three actions later somewhere else
// entirely. A marker that another marker can satisfy proves nothing.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const casesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const channels = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const indistinguishable = (a, b, tolerance) =>
  channels(a).every((value, index) => Math.abs(value - channels(b)[index]) <= tolerance);

for (const file of readdirSync(casesDir).filter((name) => name.endsWith('.pair.json'))) {
  test(`${file}: every waited marker is distinguishable from the others`, () => {
    const pair = JSON.parse(readFileSync(path.join(casesDir, file), 'utf8'));
    const waits = (pair.actions ?? [])
      .filter((action) => action.type === 'waitForColor' && action.color)
      .map((action) => ({
        name: action.name,
        color: action.color.toLowerCase(),
        tolerance: Number(action.tolerance ?? 35),
      }));

    for (const [index, marker] of waits.entries()) {
      for (const other of waits.slice(0, index)) {
        // The same colour reused for two phases is a different thing: the case is
        // waiting for that colour to appear again, which is legitimate.
        if (marker.color === other.color) continue;
        const tolerance = Math.max(marker.tolerance, other.tolerance);
        assert.ok(
          !indistinguishable(marker.color, other.color, tolerance),
          `"${marker.name}" ${marker.color} is within tolerance ${tolerance} of "${other.name}" ${other.color}: `
          + 'either marker satisfies the other, so neither proves its phase was reached',
        );
      }
    }
  });
}
