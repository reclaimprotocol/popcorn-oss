import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(harnessRoot, 'src', 'cli.mjs');

function image(file, rgb) {
  const png = new PNG({ width: 10, height: 10 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = rgb[0];
    png.data[offset + 1] = rgb[1];
    png.data[offset + 2] = rgb[2];
    png.data[offset + 3] = 255;
  }
  writeFileSync(file, PNG.sync.write(png));
}

function runManifest(directory, name, beforeRgb, afterRgb) {
  mkdirSync(directory);
  image(path.join(directory, 'before.png'), beforeRgb);
  image(path.join(directory, 'after.png'), afterRgb);
  const actions = [
    { type: 'waitForColor', name: 'before-state', status: 'OK', observation: { color: '#00d084' } },
    { type: 'screenshot', name: 'before', syncWith: 'before-state', status: 'OK' },
    { type: 'waitForColor', name: 'after-state', status: 'OK', observation: { color: '#00ff6a' } },
    { type: 'screenshot', name: 'after', syncWith: 'after-state', status: 'OK' },
  ];
  const manifest = {
    schemaVersion: 1,
    name,
    status: 'COMPLETE',
    actions,
    artifacts: [
      { type: 'screenshot', name: 'before', file: 'before.png' },
      { type: 'screenshot', name: 'after', file: 'after.png' },
    ],
  };
  const file = path.join(directory, 'run.json');
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

test('neutral comparator uses only explicit pixel threshold for verdict', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-comparison-'));
  const baseline = runManifest(path.join(directory, 'baseline'), 'baseline', [0, 0, 0], [0, 0, 0]);
  const candidate = runManifest(path.join(directory, 'candidate'), 'candidate', [0, 0, 0], [255, 255, 255]);
  const reviewOutput = path.join(directory, 'review');
  const failOutput = path.join(directory, 'fail');
  const common = ['compare', '--baseline', baseline, '--candidate', candidate, '--from', 'before', '--to', 'after'];

  const review = spawnSync(process.execPath, [cli, ...common, '--output', reviewOutput], { encoding: 'utf8' });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(reviewOutput, 'comparison.json'))).verdict, 'REVIEW');

  const fail = spawnSync(process.execPath, [
    cli, ...common,
    '--output', failOutput,
    '--max-changed-pixel-ratio', '0.5',
  ], { encoding: 'utf8' });
  assert.equal(fail.status, 0, fail.stderr);
  const comparison = JSON.parse(readFileSync(path.join(failOutput, 'comparison.json')));
  assert.equal(comparison.verdict, 'FAIL');
  assert.equal(comparison.profile, 'checkpoint-pixel-diff');
  assert.equal(comparison.maximumChangedPixelRatio, 1);
  assert.equal(comparison.summaryMetrics.length, 3);
});

test('relative comparator compares each side transition instead of exact cross-side pixels', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-relative-comparison-'));
  const baseline = runManifest(path.join(directory, 'baseline'), 'baseline', [0, 0, 0], [255, 255, 255]);
  const candidate = runManifest(path.join(directory, 'candidate'), 'candidate', [255, 0, 0], [0, 255, 0]);
  const output = path.join(directory, 'relative');

  const result = spawnSync(process.execPath, [
    cli, 'compare', '--baseline', baseline, '--candidate', candidate,
    '--from', 'before', '--to', 'after', '--output', output,
    '--profile', 'relative-transition-diff', '--max-transition-ratio-delta', '0.01',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const comparison = JSON.parse(readFileSync(path.join(output, 'comparison.json')));
  assert.equal(comparison.profile, 'relative-transition-diff');
  assert.equal(comparison.verdict, 'PASS');
  assert.equal(comparison.transitions.baseline.changedPixelRatio, 1);
  assert.equal(comparison.transitions.candidate.changedPixelRatio, 1);
  assert.equal(comparison.transitionRatioDelta, 0);
  assert.equal(comparison.summaryMetrics.length, 4);
});
