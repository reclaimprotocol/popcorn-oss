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

test('a missing manifest is an error unless skipping is requested, and skips are reported', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-dashboard-skip-'));
  const present = path.join(directory, 'present');
  mkdirSync(present, { recursive: true });
  writeFileSync(path.join(present, 'pair.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'present-case',
    status: 'COMPLETE',
    verdict: 'PASS',
    reason: 'kept',
    platform: 'Android',
    browser: { name: 'Android WebView', platformName: 'Android' },
  }));
  const configFile = path.join(directory, 'current.json');
  writeFileSync(configFile, JSON.stringify({
    schemaVersion: 1,
    title: 'Skip test',
    entries: [
      { manifest: 'present/pair.json', label: 'present-case', tags: [] },
      { manifest: 'pruned/pair.json', label: 'pruned-case', tags: [] },
    ],
  }));
  const outputFile = path.join(directory, 'out', 'index.html');

  assert.throws(() => buildDashboard({ configFile, outputFile }), /pruned\/pair\.json/);

  buildDashboard({ configFile, outputFile, skipMissing: true });
  const html = readFileSync(outputFile, 'utf8');
  assert.match(html, /Missing manifests/);
  assert.match(html, /pruned-case/);
  assert.match(html, /present-case/);
  const buildManifest = JSON.parse(readFileSync(path.join(path.dirname(outputFile), 'dashboard-manifest.json'), 'utf8'));
  assert.equal(buildManifest.entries.length, 1);
  assert.deepEqual(buildManifest.skippedEntries, [{ manifest: 'pruned/pair.json', label: 'pruned-case' }]);
});
