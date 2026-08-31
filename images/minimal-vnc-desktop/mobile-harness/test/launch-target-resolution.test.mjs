import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadEnvironment, materializePair, resolveEnvironmentLaunchTargets } from '../src/environment.mjs';

function workspace(extra) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'popcorn-harness-launch-'));
  mkdirSync(path.join(directory, 'cases'));
  mkdirSync(path.join(directory, 'environments'));
  const environmentFile = path.join(directory, 'environments', 'lab.local.json');
  writeFileSync(environmentFile, JSON.stringify({
    schemaVersion: 1,
    name: 'lab',
    defaultSimulator: 'android',
    simulators: {
      android: { device: { platformName: 'Android', udid: 'emulator-5554', name: 'Pixel' } },
      ios: { device: { platformName: 'iOS', udid: 'SIMULATOR-1', name: 'iPhone' } },
    },
    fixtures: { baseUrl: 'http://fixtures.example/harness/fixture/' },
    ...extra,
  }));
  return { directory, environmentFile, caseFile: path.join(directory, 'cases', 'shell.pair.json') };
}

function pair(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'shell',
    baseline: { fixturePath: 'cases/shell.html' },
    candidate: {},
    ...overrides,
  };
}

test('each platform keeps its historical default and the case stays untouched', () => {
  const { environmentFile, caseFile } = workspace({});
  const environment = loadEnvironment(environmentFile);
  const original = pair();
  const asWritten = structuredClone(original);

  const android = materializePair(original, caseFile, environment, 'android');
  const ios = materializePair(pair(), caseFile, environment, 'ios');

  assert.deepEqual(original, asWritten);
  assert.equal(android.baseline.launchTarget.name, 'chrome');
  assert.equal(android.baseline.launchTarget.package, 'com.android.chrome');
  assert.equal(android.candidate.launchTarget.urlDelivery, 'view-intent');
  assert.equal(ios.baseline.launchTarget.name, 'safari');
  assert.equal(ios.baseline.launchTarget.browserName, 'Safari');
  assert.equal(ios.candidate.launchTarget.urlDelivery, 'open-url');
  assert.equal(ios.baseline.launchTarget.bundleId, undefined);
});

test('one shell name selects the right host app on either platform', () => {
  const { environmentFile, caseFile } = workspace({});
  const environment = loadEnvironment(environmentFile);

  const android = materializePair(pair({ launchTarget: 'webview-shell' }), caseFile, environment, 'android');
  const ios = materializePair(pair({ launchTarget: 'webview-shell' }), caseFile, environment, 'ios');

  assert.equal(android.baseline.launchTarget.package, 'org.reclaimprotocol.popcorn.webviewshell');
  assert.equal(android.baseline.launchTarget.urlDelivery, 'extra');
  assert.ok(path.isAbsolute(android.candidate.launchTarget.apk));
  assert.ok(android.candidate.launchTarget.apk.endsWith('popcorn-webview-shell.apk'));

  assert.equal(ios.baseline.launchTarget.bundleId, 'org.reclaimprotocol.popcorn.webviewshell');
  // A custom scheme would make iOS ask the tester to confirm the app launch.
  assert.equal(ios.baseline.launchTarget.urlDelivery, 'launch-args');
  assert.ok(ios.candidate.launchTarget.app.endsWith('PopcornWebViewShell.app'));
  assert.equal(android.launchTarget, undefined);
  assert.equal(ios.launchTarget, undefined);
});

test('one side can run in the browser while the other runs in the shell', () => {
  const { environmentFile, caseFile } = workspace({});
  const environment = loadEnvironment(environmentFile);

  const resolved = materializePair(
    pair({ baseline: { fixturePath: 'cases/shell.html', launchTarget: 'safari' }, candidate: { launchTarget: 'webview-shell' } }),
    caseFile,
    environment,
    'ios',
  );

  assert.equal(resolved.baseline.launchTarget.browserName, 'Safari');
  assert.equal(resolved.candidate.launchTarget.bundleId, 'org.reclaimprotocol.popcorn.webviewshell');
});

test('an environment overrides shell details and resolves relative bundle paths', () => {
  const { environmentFile, caseFile, directory } = workspace({
    android: {
      defaultLaunchTarget: 'webview-shell',
      launchTargets: {
        'webview-shell': {
          package: 'com.example.host',
          activity: 'com.example.host.MainActivity',
          apk: '../vendor/host.apk',
          extras: { fullscreen: true },
        },
      },
    },
    ios: {
      defaultLaunchTarget: 'webview-shell',
      launchTargets: {
        'webview-shell': {
          bundleId: 'com.example.host',
          app: '../vendor/Host.app',
          urlDelivery: 'custom-scheme',
          scheme: 'host-app',
        },
      },
    },
  });
  const environment = loadEnvironment(environmentFile);

  const android = materializePair(pair(), caseFile, environment, 'android').baseline.launchTarget;
  const ios = materializePair(pair(), caseFile, environment, 'ios').baseline.launchTarget;

  assert.equal(android.package, 'com.example.host');
  assert.equal(android.apk, path.join(directory, 'vendor', 'host.apk'));
  assert.deepEqual(android.extras, { fullscreen: true });
  assert.equal(ios.bundleId, 'com.example.host');
  assert.equal(ios.app, path.join(directory, 'vendor', 'Host.app'));
  assert.equal(ios.urlQuery, 'url');
  assert.deepEqual(Object.keys(resolveEnvironmentLaunchTargets(environment, 'iOS')), ['safari', 'webview-shell']);
});

test('unknown names and incomplete overrides fail before a device is touched', () => {
  const { environmentFile, caseFile } = workspace({
    ios: { launchTargets: { 'host-app': { urlDelivery: 'launch-args' } } },
  });
  const environment = loadEnvironment(environmentFile);

  assert.throws(
    () => materializePair(pair({ launchTarget: 'chrome' }), caseFile, environment, 'ios'),
    /no iOS launch target named chrome/,
  );
  assert.throws(
    () => materializePair(pair({ launchTarget: 'safari' }), caseFile, environment, 'android'),
    /no Android launch target named safari/,
  );
  assert.throws(
    () => materializePair(pair({ launchTarget: 'host-app' }), caseFile, environment, 'ios'),
    /ios\.launchTargets\.host-app\.bundleId/,
  );
});
