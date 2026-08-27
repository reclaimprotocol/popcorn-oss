import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  androidIntentExtras,
  androidLaunchCommand,
  defaultAndroidLaunchTarget,
  defaultIosLaunchTarget,
  iosLaunchArgv,
} from '../src/launch-targets.mjs';

const androidShell = {
  name: 'webview-shell',
  package: 'org.reclaimprotocol.popcorn.webviewshell',
  activity: 'org.reclaimprotocol.popcorn.webviewshell.ShellActivity',
  urlDelivery: 'extra',
  urlExtra: 'url',
};

const iosShell = {
  name: 'webview-shell',
  bundleId: 'org.reclaimprotocol.popcorn.webviewshell',
  urlDelivery: 'launch-args',
  urlArgument: 'url',
  scheme: 'popcorn-shell',
};

const udid = 'SIMULATOR-1';
const liveviewUrl = 'http://gateway.example/host/test-host.html?viewer=http%3A%2F%2Fg%2Fliveview%2Fs%2Ftok&nest=1';

test('Chrome still launches through VIEW intent data', () => {
  assert.equal(
    androidLaunchCommand(defaultAndroidLaunchTarget, 'http://fixtures.example/a.html'),
    "am start -W -a android.intent.action.VIEW -p 'com.android.chrome' -d 'http://fixtures.example/a.html'",
  );
});

test('the Android shell receives the url as an extra on an explicit component', () => {
  assert.equal(
    androidLaunchCommand(androidShell, 'http://fixtures.example/a.html'),
    "am start -W -a android.intent.action.VIEW"
    + " -n 'org.reclaimprotocol.popcorn.webviewshell/org.reclaimprotocol.popcorn.webviewshell.ShellActivity'"
    + " --es 'url' 'http://fixtures.example/a.html'",
  );
});

test('Safari still launches through simctl openurl', () => {
  assert.deepEqual(
    iosLaunchArgv(defaultIosLaunchTarget, 'http://fixtures.example/a.html', udid),
    ['simctl', 'openurl', udid, 'http://fixtures.example/a.html'],
  );
});

test('the iOS shell receives the url as a launch argument', () => {
  assert.deepEqual(
    iosLaunchArgv(iosShell, 'http://fixtures.example/a.html', udid),
    [
      'simctl', 'launch', '--terminate-running-process', udid,
      'org.reclaimprotocol.popcorn.webviewshell',
      '-url', 'http://fixtures.example/a.html',
    ],
  );
});

test('iOS custom-scheme delivery percent-encodes the target url', () => {
  const argv = iosLaunchArgv(
    { ...iosShell, urlDelivery: 'custom-scheme' },
    liveviewUrl,
    udid,
  );
  assert.equal(argv[1], 'openurl');
  const launch = new URL(argv[3]);
  assert.equal(launch.protocol, 'popcorn-shell:');
  assert.equal(launch.searchParams.get('url'), liveviewUrl);
});

test('a LiveView host url survives every delivery style intact', () => {
  for (const target of [defaultAndroidLaunchTarget, androidShell]) {
    assert.ok(androidLaunchCommand(target, liveviewUrl).includes(`'${liveviewUrl}'`));
  }
  for (const target of [defaultIosLaunchTarget, iosShell]) {
    assert.ok(iosLaunchArgv(target, liveviewUrl, udid).includes(liveviewUrl));
  }
});

test('a hostile url stays one shell word on an Android device', () => {
  // The Android command is parsed by the device shell, so prove the argv split
  // by running it through a real shell with `am` replaced by an argv printer.
  const url = "http://fixtures.example/a.html?q='; touch /tmp/popcorn-harness-escape;'&r=1";
  for (const target of [defaultAndroidLaunchTarget, androidShell]) {
    const command = androidLaunchCommand(target, url);
    const printer = "am() { for argument in \"$@\"; do printf '%s\\n' \"$argument\"; done; }; ";
    const parsed = spawnSync('sh', ['-c', printer + command], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const argv = parsed.stdout.split('\n').filter(Boolean);
    assert.equal(argv.filter((argument) => argument === url).length, 1, `${target.name} lost the url`);
  }
});

test('iOS launch never builds a shell string, so a hostile url is inert', () => {
  const url = "http://fixtures.example/a.html?q='; touch /tmp/popcorn-harness-escape;'";
  assert.ok(iosLaunchArgv(iosShell, url, udid).includes(url));
});

test('Android extras are typed by JSON value', () => {
  assert.equal(
    androidIntentExtras({ fullscreen: true, wideViewPort: false, textZoom: 100, userAgent: 'HostApp/1.0' }),
    "--ez 'fullscreen' true --ez 'wideViewPort' false --ei 'textZoom' 100 --es 'userAgent' 'HostApp/1.0'",
  );
  assert.equal(androidIntentExtras(undefined), '');
});

test('extras reach both platforms in their own form', () => {
  assert.ok(androidLaunchCommand({ ...androidShell, extras: { clearData: true } }, 'http://a.test/')
    .endsWith("--ez 'clearData' true"));
  assert.deepEqual(
    iosLaunchArgv({ ...iosShell, extras: { fullscreen: true } }, 'http://a.test/', udid).slice(-2),
    ['-fullscreen', 'true'],
  );
  const scheme = iosLaunchArgv(
    { ...iosShell, urlDelivery: 'custom-scheme', extras: { fullscreen: true } },
    'http://a.test/',
    udid,
  );
  assert.equal(new URL(scheme[3]).searchParams.get('fullscreen'), 'true');
});

test('incomplete targets fail before any device command runs', () => {
  assert.throws(() => androidLaunchCommand({ ...androidShell, activity: undefined }, 'http://a.test/'), /requires an activity/);
  assert.throws(() => androidLaunchCommand(androidShell, ''), /requires a url/);
  assert.throws(() => androidLaunchCommand({ urlDelivery: 'extra' }, 'http://a.test/'), /requires a package/);
  assert.throws(() => iosLaunchArgv(iosShell, 'http://a.test/', ''), /requires a simulator udid/);
  assert.throws(() => iosLaunchArgv({ ...iosShell, bundleId: undefined }, 'http://a.test/', udid), /requires a bundleId/);
  assert.throws(
    () => iosLaunchArgv({ ...iosShell, urlDelivery: 'custom-scheme', scheme: undefined }, 'http://a.test/', udid),
    /requires a scheme/,
  );
  assert.throws(() => iosLaunchArgv({ ...iosShell, urlDelivery: 'deep-link' }, 'http://a.test/', udid), /unsupported urlDelivery/);
});

test('the Chrome target carries first-run preparation and the shells do not', () => {
  const preparation = defaultAndroidLaunchTarget.preparation;
  assert.ok(preparation.commandLineFlags.includes('--disable-fre'));
  assert.equal(preparation.commandLineFile, '/data/local/tmp/chrome-command-line');
  assert.ok(preparation.dismissNodeIds.includes('com.android.chrome:id/negative_button'));
  assert.equal(androidShell.preparation, undefined);
  assert.equal(iosShell.preparation, undefined);
  assert.equal(defaultIosLaunchTarget.preparation, undefined);
});
