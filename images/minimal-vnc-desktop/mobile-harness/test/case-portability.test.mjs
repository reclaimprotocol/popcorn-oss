// case-portability.test.mjs — the cases must not name screen coordinates.
//
// A coordinate encodes the device AND the surface it was calibrated on, so a case
// carrying one passes only where it was written. All 42 cases were converted to
// markers, window fractions, text entry, and native selectors; this test is what keeps
// them that way, because the failure mode is quiet: the gesture runs, lands somewhere
// harmless, and the case times out later on a marker that never appears.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { actionsForTarget } from '../src/pair-actions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COORDINATES = ['x', 'y', 'fromX', 'fromY', 'toX', 'toY'];

function caseFiles() {
  return readdirSync(path.join(root, 'cases'))
    .filter((name) => name.endsWith('.pair.json'))
    .map((name) => ({ name, pair: JSON.parse(readFileSync(path.join(root, 'cases', name), 'utf8')) }));
}

// Coordinates hide inside override blocks, where an audit of action types alone does
// not see them: a `wait` with a platformTargetOverrides entry becomes a tap.
function coordinateSites(node, trail = 'actions') {
  if (Array.isArray(node)) return node.flatMap((item, index) => coordinateSites(item, `${trail}[${index}]`));
  if (!node || typeof node !== 'object') return [];
  const here = COORDINATES.some((key) => key in node) ? [trail] : [];
  return here.concat(Object.entries(node).flatMap(([key, value]) => coordinateSites(value, `${trail}.${key}`)));
}

test('no case names a screen coordinate, including inside overrides', () => {
  const offenders = [];
  for (const { name, pair } of caseFiles()) {
    const sites = coordinateSites(pair.actions ?? [])
      .concat(coordinateSites(pair.candidate?.setupActions ?? [], 'candidate.setupActions'))
      .concat(coordinateSites(pair.baseline?.setupActions ?? [], 'baseline.setupActions'));
    if (sites.length) offenders.push(`${name}: ${sites.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `use a marker, a window fraction, typeText, or tapNativeElement instead:\n${offenders.join('\n')}`);
});

test('the case template does not teach a coordinate', () => {
  const template = readFileSync(path.join(root, 'templates', 'case.pair.json'), 'utf8');
  assert.deepEqual(coordinateSites(JSON.parse(template).actions ?? []), []);
});

test('every case still resolves on both platforms and both sides', () => {
  for (const { name, pair } of caseFiles()) {
    for (const platform of ['Android', 'iOS']) {
      for (const side of ['baseline', 'candidate']) {
        const actions = actionsForTarget(pair.actions ?? [], side, platform, { x: 2.75, y: 2.82 });
        assert.ok(actions.length > 0, `${name} has no actions on ${platform}/${side}`);
        // A comparison checkpoint filtered out by a platform gate would leave the run
        // with nothing to compare.
        const screenshots = new Set(actions.filter((a) => a.type === 'screenshot').map((a) => a.name));
        for (const key of ['from', 'to']) {
          const checkpoint = pair.compare?.[key];
          if (checkpoint) {
            assert.ok(screenshots.has(checkpoint), `${name}: checkpoint ${checkpoint} missing on ${platform}/${side}`);
          }
        }
      }
    }
  }
});

test('a native-element action can address the platform it runs on', () => {
  for (const { name, pair } of caseFiles()) {
    for (const action of pair.actions ?? []) {
      if (action.type !== 'tapNativeElement') continue;
      const platforms = action.platforms ?? ['Android', 'iOS'];
      for (const platform of platforms) {
        const spec = platform === 'Android' ? action.android : action.ios;
        assert.ok(spec, `${name}: ${action.name} runs on ${platform} with no ${platform} selector`);
      }
    }
  }
});
