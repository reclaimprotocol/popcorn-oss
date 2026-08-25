import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadEnvironment, materializePair } from '../src/environment.mjs';

test('environment supplies infrastructure without changing the case', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-environment-'));
  const casesDirectory = path.join(directory, 'cases');
  const environmentsDirectory = path.join(directory, 'environments');
  mkdirSync(casesDirectory);
  mkdirSync(environmentsDirectory);
  const environmentFile = path.join(environmentsDirectory, 'lab.local.json');
  writeFileSync(environmentFile, JSON.stringify({
    schemaVersion: 1,
    name: 'lab',
    defaultSimulator: 'primary',
    simulators: {
      primary: {
        device: { udid: 'SIMULATOR-1', name: 'iPhone', platformVersion: '18.0' },
        appiumPort: 4723,
      },
      secondary: {
        device: { udid: 'SIMULATOR-2', name: 'iPhone Plus', platformVersion: '18.0' },
        appiumPort: 4724,
      },
    },
    fixtures: { baseUrl: 'http://fixtures.example/harness/fixture/' },
    popcorn: {
      sessionProvider: {
        ssh: 'tester@cluster.example',
        adminTokenEnv: 'TEST_POPCORN_TOKEN',
      },
      liveview: {
        gatewayOrigin: 'http://gateway.example',
        hostParams: { magnify: 1, panel: 0 },
      },
    },
  }));
  const caseFile = path.join(casesDirectory, 'focus.pair.json');
  const pair = {
    schemaVersion: 1,
    name: 'focus',
    baseline: { fixturePath: 'cases/focus.html' },
    candidate: { liveview: { hostParams: { quality: 7 } } },
  };
  const original = structuredClone(pair);

  const environment = loadEnvironment(environmentFile, { TEST_POPCORN_TOKEN: 'secret-at-runtime' });
  const resolved = materializePair(pair, caseFile, environment);

  assert.deepEqual(pair, original);
  assert.equal(resolved.device.udid, 'SIMULATOR-1');
  assert.equal(resolved.appiumPort, 4723);
  assert.equal(resolved.baseline.url, 'http://fixtures.example/harness/fixture/cases/focus.html');
  assert.deepEqual(resolved.candidate.liveview.hostParams, { magnify: 1, panel: 0, quality: 7 });
  assert.equal(resolved.sessionProvider.adminToken, 'secret-at-runtime');
  assert.deepEqual(resolved.navigation, { method: 'cdp-page-navigate', source: 'baseline' });
  assert.deepEqual(Object.keys(resolved.environment).sort(), ['file', 'name', 'simulator']);
  assert.equal(resolved.environment.simulator, 'primary');
  assert.doesNotMatch(JSON.stringify(resolved.environment), /secret-at-runtime/);

  const secondary = materializePair(pair, caseFile, environment, 'secondary');
  assert.equal(secondary.device.udid, 'SIMULATOR-2');
  assert.equal(secondary.appiumPort, 4724);
  assert.equal(secondary.environment.simulator, 'secondary');
});

test('case can explicitly override built-in Popcorn startup navigation', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-navigation-'));
  const environmentFile = path.join(directory, 'lab.local.json');
  writeFileSync(environmentFile, JSON.stringify({
    schemaVersion: 1,
    name: 'lab',
    simulator: { device: { udid: 'SIMULATOR-1' } },
    popcorn: { sessionProvider: { adminToken: 'local-test-token' } },
  }));

  const loaded = loadEnvironment(environmentFile, {});
  const resolved = materializePair({
    name: 'navigation-override',
    navigation: { method: 'none' },
  }, path.join(directory, 'case.pair.json'), loaded);

  assert.deepEqual(resolved.navigation, { method: 'none', source: 'baseline' });
});

test('missing environment token fails before a run starts', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-token-'));
  const environmentFile = path.join(directory, 'lab.local.json');
  writeFileSync(environmentFile, JSON.stringify({
    schemaVersion: 1,
    name: 'lab',
    popcorn: { sessionProvider: { adminTokenEnv: 'MISSING_TEST_TOKEN' } },
  }));

  assert.throws(
    () => loadEnvironment(environmentFile, {}),
    /environment variable MISSING_TEST_TOKEN/,
  );
});
