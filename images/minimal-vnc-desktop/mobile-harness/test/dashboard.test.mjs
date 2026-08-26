import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDashboard } from '../src/dashboard.mjs';

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('dashboard includes only explicitly selected pair manifests', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-dashboard-'));
  const results = path.join(directory, 'results');
  const configs = path.join(directory, 'dashboards');
  const output = path.join(directory, 'public', 'index.html');
  mkdirSync(results);
  mkdirSync(configs);

  const selectedDirectory = path.join(results, 'selected');
  const ignoredDirectory = path.join(results, 'ignored');
  mkdirSync(selectedDirectory);
  mkdirSync(ignoredDirectory);
  writeJson(path.join(selectedDirectory, 'pair.json'), {
    schemaVersion: 1,
    name: 'selected-visible-case',
    testDescription: 'Selected evidence only.',
    verdict: 'PASS',
    baseline: 'baseline/run.json',
  });
  mkdirSync(path.join(selectedDirectory, 'baseline'));
  writeJson(path.join(selectedDirectory, 'baseline', 'run.json'), {
    schemaVersion: 1,
    device: { platformName: 'Android', name: 'Pixel test device', platformVersion: '16' },
    browser: { name: 'Chrome', platformName: 'Android' },
    artifacts: [{
      type: 'video',
      variant: 'touch-evidence',
      file: 'screen-touches.mp4',
      sha256: '1234567890abcdefcafebabefeedface',
    }],
  });
  writeFileSync(path.join(selectedDirectory, 'baseline', 'screen-touches.mp4'), 'test video');
  writeJson(path.join(ignoredDirectory, 'pair.json'), {
    schemaVersion: 1,
    name: 'must-not-be-discovered',
    verdict: 'FAIL',
  });

  const configFile = path.join(configs, 'current.json');
  writeJson(configFile, {
    schemaVersion: 1,
    title: 'Explicit test dashboard',
    entries: [{ manifest: '../results/selected/pair.json', label: 'Chosen result' }],
  });

  buildDashboard({ configFile, outputFile: output });
  const html = readFileSync(output, 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(output), 'dashboard-manifest.json')));

  assert.match(html, /Chosen result/);
  assert.match(html, /Selected evidence only/);
  assert.match(html, /data-platform="Android"/);
  assert.match(html, /Chrome · Pixel test device · Android 16/);
  assert.match(html, /All platforms/);
  assert.match(html, /Both views/);
  assert.match(html, /screen-touches\.mp4\?v=1234567890abcdef/);
  assert.doesNotMatch(html, /must-not-be-discovered/);
  assert.equal(manifest.entries.length, 1);
  assert.match(manifest.entries[0], /selected\/pair\.json$/);
});

test('empty configuration produces a clean empty dashboard', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-empty-dashboard-'));
  const configFile = path.join(directory, 'empty.json');
  const output = path.join(directory, 'index.html');
  writeJson(configFile, { schemaVersion: 1, title: 'Fresh start', entries: [] });

  buildDashboard({ configFile, outputFile: output });
  const html = readFileSync(output, 'utf8');

  assert.match(html, /0<\/b> selected results/);
  assert.match(html, /No result manifests were selected/);
});
