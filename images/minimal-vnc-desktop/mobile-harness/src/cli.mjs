import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  androidLaunchCommand,
  defaultLaunchTarget,
  iosLaunchArgv,
} from './launch-targets.mjs';
import {
  publishCompletedDirectory,
  removeStaleStagingDirectories,
  stagingDirectory,
} from './artifact-lifecycle.mjs';
import {
  checkEnvironment,
  loadEnvironment,
  materializePair,
  resolveEnvironmentLaunchTargets,
} from './environment.mjs';
import { androidMultiTouchPayload, pointerGestures } from './android-touch.mjs';
import { liveviewHostUrl, readEncryption } from './liveview-url.mjs';
import { actionsForTarget, runsOnPlatform } from './pair-actions.mjs';
import { colorGeometry } from './pinch-integrity.mjs';
import { shellQuote } from './shell-quote.mjs';
import {
  androidInputTextCommand,
  androidKeyeventCommand,
  iosKeySequence,
  nativeElementSelector,
} from './text-entry.mjs';
import { refuseBusyRuntime } from './runtime-busy.mjs';
import { resolveWindowFractions } from './window-fractions.mjs';
import { describeSpec, resolveTapTarget, scrollGestureFor } from './android-ui.mjs';
import { buildTouchTracks, coordinateExpression, recordingTimeline } from './touch-tracks.mjs';
import { analyzeViewportScreenshots } from './viewport-vision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appiumHome = path.join(root, '.appium');
const appiumBin = path.join(root, 'node_modules', '.bin', 'appium');
const cliFile = fileURLToPath(import.meta.url);

function die(message) {
  console.error(message);
  process.exit(1);
}

function commandExists(command) {
  return spawnSync('/usr/bin/env', ['sh', '-lc', `command -v ${command}`], {
    encoding: 'utf8',
  }).status === 0;
}

function requireSupportedNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    die(`Node >=24 is required (current ${process.version}). Activate a supported Node version before running npm scripts`);
  }
}

function bootedSimulator(udid) {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error('CoreSimulator health check timed out after 10 seconds');
  }
  if (result.status !== 0) {
    throw new Error(`CoreSimulator health check failed: ${(result.stderr || result.error?.message || 'unknown error').trim()}`);
  }
  const devices = Object.values(JSON.parse(result.stdout).devices ?? {}).flat();
  const device = devices.find((item) => item.udid === udid && item.state === 'Booted');
  if (!device) throw new Error(`Assigned simulator ${udid} is not booted`);
  return { udid: device.udid, name: device.name, state: device.state };
}

function platformName(device) {
  const value = String(device?.platformName ?? 'iOS').toLowerCase();
  if (value === 'ios') return 'iOS';
  if (value === 'android') return 'Android';
  throw new Error(`Unsupported mobile platform ${device?.platformName}`);
}

function browserName(device, launchTarget) {
  return launchTarget?.label ?? defaultLaunchTarget(platformName(device)).label;
}

function launchTargetRecord(target) {
  return {
    name: target.name,
    label: target.label ?? target.name,
    urlDelivery: target.urlDelivery,
  };
}

function md5(file) {
  return createHash('md5').update(readFileSync(file)).digest('hex');
}

// What is actually installed, so a rebuilt shell cannot keep running as a stale
// copy while the manifest claims the local build was used.
function androidInstalledApkDigest(udid, packageName) {
  const listed = adbAttempt(udid, ['shell', 'pm', 'path', packageName]);
  const file = /package:(\S+)/.exec(listed.output)?.[1];
  if (!file) return null;
  const sum = adbAttempt(udid, ['shell', 'md5sum', file], 120000);
  const digest = /\b([0-9a-f]{32})\b/.exec(sum.output)?.[1];
  return digest ? { file, md5: digest } : null;
}

function ensureAndroidLaunchTarget(udid, target) {
  const record = { ...launchTargetRecord(target), package: target.package, activity: target.activity ?? null };
  const listed = spawnSync('adb', ['-s', udid, 'shell', 'pm', 'list', 'packages', target.package], {
    encoding: 'utf8', timeout: 20000,
  });
  record.installed = listed.status === 0
    && listed.stdout.split(/\r?\n/).map((line) => line.trim()).includes(`package:${target.package}`);
  if (record.installed && !target.reinstall) {
    if (!target.apk || !existsSync(target.apk)) return record;
    const onDevice = androidInstalledApkDigest(udid, target.package);
    const local = md5(target.apk);
    if (onDevice && onDevice.md5 === local) {
      record.installedApk = { file: path.basename(target.apk), sha256: sha256(target.apk) };
      return record;
    }
    // Either the build changed or the device copy cannot be read; reinstall so
    // the run uses the shell that was built here.
    record.replacedStaleBuild = { deviceMd5: onDevice?.md5 ?? null, localMd5: local };
  }
  if (!target.apk) {
    throw new Error(`Android launch target ${target.name} package ${target.package} is not installed on ${udid} and the environment defines no apk to install`);
  }
  if (!existsSync(target.apk)) {
    throw new Error(`Android launch target ${target.name} needs ${target.apk}; build it with android/webview-shell/build.sh`);
  }
  // -g grants declared runtime permissions so a camera or microphone gate in
  // the page cannot stall behind an invisible system dialog.
  const install = () => adbAttempt(udid, ['install', '-r', '-g', target.apk], 300000);
  let installed = install();
  if (!installed.ok && /signatures do not match|INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(installed.output)) {
    // A shell rebuilt with a different signing key cannot upgrade in place, and
    // in a lab that is a rebuild rather than a threat.
    adbAttempt(udid, ['uninstall', target.package], 120000);
    record.replacedMismatchedSignature = true;
    installed = install();
  }
  if (!installed.ok) {
    throw new Error(`Install Android launch target ${target.name} failed: ${installed.output}`);
  }
  record.installed = true;
  record.installedApk = { file: path.basename(target.apk), sha256: sha256(target.apk) };
  return record;
}

function iosAppInstalled(udid, bundleId) {
  return spawnSync('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], {
    encoding: 'utf8', timeout: 30000,
  }).status === 0;
}

function ensureIosLaunchTarget(udid, target) {
  const record = { ...launchTargetRecord(target), bundleId: target.bundleId ?? null };
  if (!target.bundleId) {
    // A system handler such as Safari: nothing to install.
    record.installed = true;
    return record;
  }
  record.installed = iosAppInstalled(udid, target.bundleId);
  if (record.installed && !target.reinstall) return record;
  if (!target.app) {
    throw new Error(`iOS launch target ${target.name} bundle ${target.bundleId} is not installed on ${udid} and the environment defines no app to install`);
  }
  if (!existsSync(target.app)) {
    throw new Error(`iOS launch target ${target.name} needs ${target.app}; build it with ios/webview-shell/build.sh`);
  }
  const installed = spawnSync('xcrun', ['simctl', 'install', udid, target.app], {
    encoding: 'utf8', timeout: 300000,
  });
  if (installed.status !== 0) {
    throw new Error(`Install iOS launch target ${target.name} failed: ${(installed.stderr || installed.stdout).trim()}`);
  }
  // Installing into a booted simulator returns before installd has finished, so
  // wait for the container to exist. An unconfirmed install is silently
  // discarded when the simulator restarts.
  const deadline = Date.now() + 60000;
  while (!iosAppInstalled(udid, target.bundleId)) {
    if (Date.now() > deadline) {
      throw new Error(`iOS launch target ${target.name} did not finish installing on ${udid} within 60s`);
    }
    spawnSync('/bin/sleep', ['0.5']);
  }
  record.installed = true;
  record.installedApp = { bundle: path.basename(target.app) };
  return record;
}

function ensureLaunchTarget(platform, udid, target) {
  return platform === 'Android'
    ? ensureAndroidLaunchTarget(udid, target)
    : ensureIosLaunchTarget(udid, target);
}

function bootedAndroidDevice(udid) {
  const state = spawnSync('adb', ['-s', udid, 'get-state'], { encoding: 'utf8', timeout: 10000 });
  if (state.status !== 0 || state.stdout.trim() !== 'device') {
    throw new Error(`Assigned Android device ${udid} is not connected: ${(state.stderr || state.stdout || 'adb get-state failed').trim()}`);
  }
  const boot = spawnSync('adb', ['-s', udid, 'shell', 'getprop', 'sys.boot_completed'], { encoding: 'utf8', timeout: 10000 });
  if (boot.status !== 0 || boot.stdout.trim() !== '1') throw new Error(`Assigned Android device ${udid} has not finished booting`);
  const model = spawnSync('adb', ['-s', udid, 'shell', 'getprop', 'ro.product.model'], { encoding: 'utf8', timeout: 10000 });
  return { udid, name: model.stdout.trim() || udid, state: 'Booted' };
}

function bootedMobileDevice(device) {
  return platformName(device) === 'Android' ? bootedAndroidDevice(device.udid) : bootedSimulator(device.udid);
}

function prepareAndroidNativeInput(udid) {
  spawnSync('adb', ['-s', udid, 'shell', 'pm', 'disable-user', '--user', '0', 'com.google.android.apps.wellbeing'], {
    encoding: 'utf8', timeout: 10000,
  });
  const setting = spawnSync('adb', ['-s', udid, 'shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1'], {
    encoding: 'utf8', timeout: 10000,
  });
  if (setting.status !== 0) {
    throw new Error(`Could not enable the Android software keyboard: ${(setting.stderr || setting.stdout).trim()}`);
  }
}

function adbAttempt(udid, args, timeout = 20000) {
  const result = spawnSync('adb', ['-s', udid, ...args], { encoding: 'utf8', timeout });
  // Both streams: adb reports install progress on stdout and the actual failure
  // on stderr, so keeping only one hides the reason.
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean).join('\n').trim();
  return { ok: result.status === 0, output };
}

// Best effort: writing the flag file needs an emulator or a rooted device, and a
// device that refuses it simply keeps whatever browser configuration it has.
function prepareAndroidLaunchTarget(udid, target) {
  const preparation = target.preparation;
  if (!preparation) return null;
  const record = { package: target.package };
  if (preparation.commandLineFile && preparation.commandLineFlags?.length) {
    const line = ['_', ...preparation.commandLineFlags].join(' ');
    const rooted = adbAttempt(udid, ['root']);
    const written = adbAttempt(udid, [
      'shell', `echo ${shellQuote(line)} > ${shellQuote(preparation.commandLineFile)}`,
    ]);
    if (written.ok) adbAttempt(udid, ['shell', 'chmod', '0644', preparation.commandLineFile]);
    if (written.ok && preparation.debugApp) {
      adbAttempt(udid, ['shell', 'am', 'set-debug-app', '--persistent', target.package]);
    }
    record.commandLineFlags = {
      file: preparation.commandLineFile,
      applied: written.ok,
      rootRequested: rooted.ok,
      error: written.ok ? null : written.output || 'adb write failed',
    };
  }
  return record;
}

const NODE_BOUNDS = 'bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"';

function centreOf(match) {
  const [left, top, right, bottom] = match.slice(1, 5).map(Number);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

// A dismissable surface, found by resource-id OR by visible text. Text matters:
// Chrome's promo has `com.android.chrome:id/negative_button`, but Firefox's
// onboarding is Compose and exposes no usable resource-id at all — only
// text="Not now" — so an id-only search left a second browser undrivable, and
// its first-run cards simply covered the page until the case timed out.
function androidDialogNode(udid, { nodeIds = [], texts = [] }) {
  if (!nodeIds.length && !texts.length) return null;
  const remote = '/sdcard/popcorn-harness-ui.xml';
  if (!adbAttempt(udid, ['shell', 'uiautomator', 'dump', remote], 30000).ok) return null;
  const dump = adbAttempt(udid, ['shell', 'cat', remote], 30000);
  if (!dump.ok) return null;
  for (const nodeId of nodeIds) {
    const match = new RegExp(`resource-id="${nodeId.replaceAll('.', '\\.')}"[^>]*${NODE_BOUNDS}`).exec(dump.output);
    if (match) return { nodeId, ...centreOf(match) };
  }
  for (const text of texts) {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Either attribute order: text before bounds, or bounds before text.
    const match = new RegExp(`text="${escaped}"[^>]*${NODE_BOUNDS}`).exec(dump.output)
      || new RegExp(`${NODE_BOUNDS}[^>]*text="${escaped}"`).exec(dump.output);
    if (match) return { text, ...centreOf(match) };
  }
  return null;
}

// Runs before the ready marker and before recording starts, so a dismissed
// promo can never appear in the evidence.
async function dismissAndroidLaunchDialogs(driver, udid, target) {
  const nodeIds = target.preparation?.dismissNodeIds ?? [];
  const texts = target.preparation?.dismissTexts ?? [];
  if (!nodeIds.length && !texts.length) return [];
  const dismissed = [];
  for (let round = 0; round < Number(target.preparation.dismissRounds ?? 3); round += 1) {
    const node = androidDialogNode(udid, { nodeIds, texts });
    if (!node) break;
    adbAttempt(udid, ['shell', 'input', 'touchscreen', 'tap', String(node.x), String(node.y)]);
    dismissed.push(node);
    await driver.pause(1200);
  }
  return dismissed;
}

function redactUrl(raw) {
  try {
    const u = new URL(raw);
    for (const key of ['viewer', 'url']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '<redacted-liveview-url>');
    }
    u.pathname = u.pathname.replace(
      /(\/liveview\/[^/]+\/)[^/]+/,
      '$1<redacted-token>',
    );
    return u.toString();
  } catch {
    return '<redacted-url>';
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run';
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function saveManifest(file, manifest) {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function refreshCurrentDashboard(pairManifestFile, pairManifest) {
  if (!['COMPLETE', 'INFRA_ERROR'].includes(pairManifest.status)) return null;
  const configFile = path.join(root, 'dashboards', 'current.json');
  const config = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, 'utf8'))
    : { schemaVersion: 1, title: 'Popcorn LiveView mobile evidence', description: 'Completed test results.', entries: [] };
  const manifest = path.relative(path.dirname(configFile), pairManifestFile);
  config.entries = (config.entries ?? []).filter((entry) => {
    const relative = typeof entry === 'string' ? entry : entry.manifest;
    return relative !== manifest;
  });
  config.entries.push({ manifest, label: pairManifest.name, tags: [] });
  saveManifest(configFile, config);
  const dashboardFile = path.join(root, 'artifacts', 'index.html');
  // The automatic refresh must not fail because an older selected result has
  // since been pruned from artifacts/. Skips are listed on the page and in
  // dashboard-manifest.json; `npm run dashboard` stays strict.
  const generated = spawnSync(process.execPath, [
    path.join(root, 'src', 'dashboard.mjs'),
    '--config', configFile,
    '--output', dashboardFile,
    '--skip-missing',
  ], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(`dashboard refresh failed: ${(generated.stderr || generated.stdout).trim()}`);
  return dashboardFile;
}

function resolveScenarioUrl(scenario, scenarioFile) {
  if (scenario.url) return scenario.url;
  if (!scenario.liveview?.sessionFile || !scenario.liveview?.gatewayOrigin || !scenario.liveview?.hostPage) {
    throw new Error('Scenario requires url, or liveview.sessionFile, gatewayOrigin, and hostPage');
  }
  const sessionFile = path.resolve(path.dirname(scenarioFile), scenario.liveview.sessionFile);
  const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
  if (!session.vncUrl) throw new Error('LiveView session file has no vncUrl');
  return liveviewHostUrl({
    vncUrl: session.vncUrl,
    gatewayOrigin: scenario.liveview.gatewayOrigin,
    hostPage: scenario.liveview.hostPage,
    hostParams: scenario.liveview.hostParams ?? {},
    encryption: scenario.liveview.encryption,
  });
}

function sanitizeAppiumLog(file) {
  const redacted = readFileSync(file, 'utf8')
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/(Authorization["':= ]+Bearer )[A-Za-z0-9._:-]+/gi, '$1<redacted>')
    .replace(/(viewer=)[^&\s"'\\]+/gi, '$1<redacted-liveview-url>')
    .replace(/(\/liveview(?:-ws)?\/[^/\s"'?]+\/)[^/\s"'?]+/gi, '$1<redacted-token>')
    .replace(/(%2Fliveview(?:-ws)?%2F[^%\s"'?]+%2F)[^%\s"'?]+/gi, '$1<redacted-token>');
  writeFileSync(file, redacted, { mode: 0o600 });
}

async function waitForServer(port, processHandle, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (processHandle.outputError) throw processHandle.outputError;
    if (processHandle.exitCode !== null) throw new Error(`Appium exited with ${processHandle.exitCode}`);
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Appium did not listen on port ${port}`);
}

function startAppium(port, logFile) {
  const output = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  const appiumArgs = ['--port', String(port), '--base-path', '/', '--log-timestamp'];
  const child = spawn(appiumBin, appiumArgs, {
    cwd: root,
    env: { ...process.env, APPIUM_HOME: appiumHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  output.on('error', (error) => {
    child.outputError = error;
    child.kill('SIGTERM');
  });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  child.outputStream = output;
  return child;
}

async function stopProcess(child, signal = 'SIGINT', timeoutMs = 15000) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill(signal);
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  if (child.outputStream) child.outputStream.end();
}

async function startVideo(udid, file) {
  const child = spawn('xcrun', [
    'simctl', 'io', udid, 'recordVideo', '--codec=h264', '--mask=ignored', '--force', file,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('simctl video recorder did not start')), 15000);
    child.once('error', reject);
    child.stderr.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('Recording started')) {
        clearTimeout(timer);
        child.recordingStartedAt = new Date().toISOString();
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`simctl video recorder exited with ${code}: ${text}`));
    });
  });
  return child;
}

async function startAndroidVideo(udid, file) {
  const remoteFile = `/sdcard/popcorn-harness-${process.pid}-${Date.now()}.mp4`;
  const recordingStartedAt = new Date().toISOString();
  const child = spawn('adb', ['-s', udid, 'shell', 'screenrecord', '--bit-rate', '6000000', remoteFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errorText = '';
  child.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) resolve();
      else reject(new Error(`Android screen recorder exited with ${child.exitCode}: ${errorText}`));
    }, 750);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Android screen recorder exited with ${code}: ${errorText}`));
    });
  });
  child.recordingStartedAt = recordingStartedAt;
  child.finishRecording = async () => {
    // Very short Android recordings can be finalized before screenrecord writes
    // usable duration metadata. Keep at least five seconds on the recorder clock
    // so ffprobe and the mandatory touch overlay have a complete MP4 timeline.
    const elapsedMs = Date.now() - Date.parse(child.recordingStartedAt);
    if (elapsedMs < 5000) await new Promise((resolve) => setTimeout(resolve, 5000 - elapsedMs));
    const recorder = spawnSync('adb', ['-s', udid, 'shell', 'pidof', 'screenrecord'], { encoding: 'utf8', timeout: 10000 });
    const recorderPids = recorder.stdout.trim().split(/\s+/).filter(Boolean);
    if (recorderPids.length) {
      spawnSync('adb', ['-s', udid, 'shell', 'kill', '-2', ...recorderPids], { encoding: 'utf8', timeout: 10000 });
      const closed = new Promise((resolve) => child.once('close', resolve));
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 20000))]);
    }
    await stopProcess(child, 'SIGTERM', 5000);
    const pull = spawnSync('adb', ['-s', udid, 'pull', remoteFile, file], { encoding: 'utf8', timeout: 60000 });
    spawnSync('adb', ['-s', udid, 'shell', 'rm', '-f', remoteFile], { encoding: 'utf8', timeout: 10000 });
    if (pull.status !== 0) throw new Error(`adb pull recording failed: ${(pull.stderr || pull.stdout).trim()}`);
  };
  return child;
}

async function startMobileVideo(device, file) {
  return platformName(device) === 'Android' ? startAndroidVideo(device.udid, file) : startVideo(device.udid, file);
}

async function finishMobileVideo(video) {
  if (!video) return;
  if (video.finishRecording) await video.finishRecording();
  else await stopProcess(video, 'SIGINT', 20000);
}

function adbCommand(udid, args, label, options = {}) {
  const result = spawnSync('adb', ['-s', udid, ...args], {
    encoding: options.binary ? null : 'utf8',
    timeout: options.timeout ?? 30000,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${label} timed out`);
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : (result.stderr || result.stdout || 'unknown adb error');
    throw new Error(`${label} failed: ${String(detail).trim()}`);
  }
  return result.stdout;
}

async function createAndroidAdbTransport(udid) {
  const screenshot = () => adbCommand(udid, ['exec-out', 'screencap', '-p'], 'Android framebuffer capture', {
    binary: true,
    timeout: 30000,
  });
  const dimensions = PNG.sync.read(screenshot());
  const tap = (x, y) => adbCommand(udid, [
    'shell', 'input', 'touchscreen', 'tap', String(Math.round(x)), String(Math.round(y)),
  ], 'Android native tap');
  // uinput rejects a payload by exiting non-zero with NOTHING on either stream —
  // the reason is in logcat — so say where to look rather than inventing one.
  const injectMultiTouch = (gestures) => {
    const result = spawnSync('adb', ['-s', udid, 'shell', 'uinput', '-'], {
      input: androidMultiTouchPayload(gestures, dimensions.width, dimensions.height),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error?.code === 'ETIMEDOUT') throw new Error('Android native touch injection timed out');
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(`Android native touch injection failed${detail ? `: ${detail}` : ''} `
        + `(uinput reports parse errors only to logcat: adb -s ${udid} logcat -d | grep -i uinput)`);
    }
  };

  const swipe = (gesture) => adbCommand(udid, [
    'shell', 'input', 'touchscreen', 'swipe',
    String(Math.round(gesture.fromX)), String(Math.round(gesture.fromY)),
    String(Math.round(gesture.toX)), String(Math.round(gesture.toY)),
    String(Math.max(100, Math.round(gesture.durationMs || 450))),
  ], 'Android native swipe');
  return {
    capabilities: { platformName: 'Android', transport: 'adb-native' },
    async takeScreenshot() { return screenshot().toString('base64'); },
    async pause(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); },
    async getWindowRect() { return { x: 0, y: 0, width: dimensions.width, height: dimensions.height }; },
    async performActions(pointers) {
      const gestureSets = pointers.map(pointerGestures);
      if (gestureSets.length === 1) {
        for (const gesture of gestureSets[0]) {
          if (gesture.delayBeforeMs) await new Promise((resolve) => setTimeout(resolve, gesture.delayBeforeMs));
          const stationary = gesture.fromX === gesture.toX && gesture.fromY === gesture.toY;
          if (stationary) { tap(gesture.fromX, gesture.fromY); continue; }
          // `input swipe` cannot press-and-hold, so a long-press drag has to go
          // through the same uinput path the pinches use — one finger there is a
          // press, a hold, interpolated moves, then a release.
          if (gesture.holdMs > 0) { injectMultiTouch([gesture]); continue; }
          swipe(gesture);
        }
        return;
      }
      const gestures = gestureSets.map((set) => set[0]);
      if (gestures.some((gesture) => !gesture)) throw new Error('Android multi-touch action is incomplete');
      injectMultiTouch(gestures);
    },
    async releaseActions() {},
    async execute(command, args) {
      if (command === 'mobile: tap') {
        tap(args.x, args.y);
        return;
      }
      if (command === 'mobile: doubleClickGesture' || command === 'mobile: doubleTap') {
        tap(args.x, args.y);
        await new Promise((resolve) => setTimeout(resolve, 80));
        tap(args.x, args.y);
        return;
      }
      throw new Error(`${command} is not available through the Android ADB touch transport`);
    },
    async setOrientation(orientation) {
      adbCommand(udid, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'], 'Disable Android auto-rotation');
      adbCommand(udid, ['shell', 'settings', 'put', 'system', 'user_rotation', orientation === 'LANDSCAPE' ? '1' : '0'], 'Set Android orientation');
    },
    async deleteSession() {},
  };
}

async function nativeTap(driver, x, y) {
  const at = new Date().toISOString();
  await driver.performActions([{
    type: 'pointer',
    id: 'finger',
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 80 },
      { type: 'pointerUp', button: 0 },
    ],
  }]);
  await driver.releaseActions();
  return { kind: 'tap', x, y, at };
}

async function nativeRepeatedTap(driver, x, y, count, intervalMs) {
  const actions = [{ type: 'pointerMove', duration: 0, origin: 'viewport', x, y }];
  const touches = [];
  for (let index = 0; index < count; index += 1) {
    touches.push({ kind: 'tap', x, y, at: new Date().toISOString() });
    actions.push({ type: 'pointerDown', button: 0 });
    actions.push({ type: 'pause', duration: 70 });
    actions.push({ type: 'pointerUp', button: 0 });
    if (index + 1 < count) actions.push({ type: 'pause', duration: Math.max(30, intervalMs) });
  }
  await driver.performActions([{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions }]);
  await driver.releaseActions();
  return touches;
}

async function nativeSwipe(driver, action) {
  const startedAt = new Date().toISOString();
  await driver.performActions([{
    type: 'pointer',
    id: 'finger',
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: action.fromX, y: action.fromY },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: action.durationMs ?? 450, origin: 'viewport', x: action.toX, y: action.toY },
      { type: 'pointerUp', button: 0 },
    ],
  }]);
  await driver.releaseActions();
  if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
  return [
    { kind: 'swipe-start', x: action.fromX, y: action.fromY, at: startedAt },
    { kind: 'swipe-end', x: action.toX, y: action.toY, at: new Date().toISOString() },
  ];
}

async function nativeDrag(driver, action) {
  const startedAt = new Date().toISOString();
  const steps = Math.max(2, Math.min(30, Math.round(Number(action.steps ?? 12))));
  const durationMs = Math.max(100, Number(action.durationMs ?? 900));
  const moveDuration = Math.max(16, Math.round(durationMs / steps));
  const pointerActions = [
    { type: 'pointerMove', duration: 0, origin: 'viewport', x: action.fromX, y: action.fromY },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: Math.max(0, Number(action.holdMs ?? 180)) },
  ];
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    pointerActions.push({
      type: 'pointerMove',
      duration: moveDuration,
      origin: 'viewport',
      x: Math.round(action.fromX + (action.toX - action.fromX) * progress),
      y: Math.round(action.fromY + (action.toY - action.fromY) * progress),
    });
  }
  pointerActions.push({ type: 'pause', duration: Math.max(0, Number(action.releasePauseMs ?? 100)) });
  pointerActions.push({ type: 'pointerUp', button: 0 });
  await driver.performActions([{
    type: 'pointer',
    id: 'finger',
    parameters: { pointerType: 'touch' },
    actions: pointerActions,
  }]);
  await driver.releaseActions();
  return [
    { kind: 'drag-start', x: action.fromX, y: action.fromY, at: startedAt },
    { kind: 'drag-end', x: action.toX, y: action.toY, at: new Date().toISOString() },
  ];
}

async function nativePinch(driver, action) {
  const startedAt = new Date().toISOString();
  if (action.engine === 'mobile') {
    await driver.execute('mobile: pinch', {
      scale: Math.max(0.1, Number(action.endRadius) / Math.max(1, Number(action.startRadius))),
      velocity: Number(action.velocity ?? 1.2),
    });
    const endedAt = new Date().toISOString();
    return [
      { kind: 'pinch-left-start', x: Math.round(action.centerX - action.startRadius), y: action.centerY, at: startedAt },
      { kind: 'pinch-right-start', x: Math.round(action.centerX + action.startRadius), y: action.centerY, at: startedAt },
      { kind: 'pinch-left-end', x: Math.round(action.centerX - action.endRadius), y: action.centerY, at: endedAt },
      { kind: 'pinch-right-end', x: Math.round(action.centerX + action.endRadius), y: action.centerY, at: endedAt },
    ];
  }
  const steps = Math.max(2, Math.min(24, Math.round(Number(action.steps ?? 10))));
  const durationMs = Math.max(120, Number(action.durationMs ?? 800));
  const moveDuration = Math.max(16, Math.round(durationMs / steps));
  const finger = (id, direction) => {
    const actions = [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(action.centerX + direction * action.startRadius), y: action.centerY },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: Math.max(0, Number(action.holdMs ?? 100)) },
    ];
    for (let step = 1; step <= steps; step += 1) {
      const radius = action.startRadius + (action.endRadius - action.startRadius) * (step / steps);
      actions.push({ type: 'pointerMove', duration: moveDuration, origin: 'viewport', x: Math.round(action.centerX + direction * radius), y: action.centerY });
    }
    actions.push({ type: 'pointerUp', button: 0 });
    return { type: 'pointer', id, parameters: { pointerType: 'touch' }, actions };
  };
  await driver.performActions([finger('finger-left', -1), finger('finger-right', 1)]);
  await driver.releaseActions();
  const endedAt = new Date().toISOString();
  return [
    { kind: 'pinch-left-start', x: Math.round(action.centerX - action.startRadius), y: action.centerY, at: startedAt },
    { kind: 'pinch-right-start', x: Math.round(action.centerX + action.startRadius), y: action.centerY, at: startedAt },
    { kind: 'pinch-left-end', x: Math.round(action.centerX - action.endRadius), y: action.centerY, at: endedAt },
    { kind: 'pinch-right-end', x: Math.round(action.centerX + action.endRadius), y: action.centerY, at: endedAt },
  ];
}

function writeTouchIndicator(file) {
  const size = 96;
  const center = (size - 1) / 2;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const distance = Math.hypot(x - center, y - center);
      let color = [0, 0, 0, 0];
      if (distance <= 43 && distance >= 34) color = [255, 235, 59, 235];
      else if (distance < 34) color = [255, 235, 59, 85];
      if (distance <= 8) color = [255, 255, 255, 245];
      [png.data[offset], png.data[offset + 1], png.data[offset + 2], png.data[offset + 3]] = color;
    }
  }
  writeFileSync(file, PNG.sync.write(png), { mode: 0o600 });
}

function renderTouchVideo(videoFile, outputFile, indicatorFile, manifest) {
  const hasTouches = manifest.actions.some((action) => action.touches?.length || action.observation?.touch || action.observation?.touches?.length);
  if (!hasTouches) return { status: 'SKIPPED', reason: 'No recorded native touches' };
  if (!manifest.video?.startedAt || !manifest.window?.width || !manifest.window?.height) {
    return { status: 'SKIPPED', reason: 'Missing video timeline or native window dimensions' };
  }
  if (!commandExists('ffmpeg') || !commandExists('ffprobe')) {
    return { status: 'SKIPPED', reason: 'ffmpeg and ffprobe are required for touch overlays' };
  }
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames:format=duration', '-of', 'json', videoFile,
  ], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr.trim()}`);
  const metadata = JSON.parse(probe.stdout);
  const width = Number(metadata.streams?.[0]?.width);
  const height = Number(metadata.streams?.[0]?.height);
  const origin = Date.parse(manifest.video.startedAt);
  const recordedDuration = Number(metadata.format?.duration);
  const sourceFrames = Number(metadata.streams?.[0]?.nb_frames);
  const lastActionAt = Math.max(origin, ...manifest.actions.map((action) => Date.parse(action.completedAt ?? action.startedAt)).filter(Number.isFinite));
  const timeline = recordingTimeline({
    recordedDuration,
    sourceFrames,
    wallClockSeconds: (lastActionAt - origin) / 1000 + 0.5,
  });
  const { duration } = timeline;
  const singleFrame = timeline.mode === 'loop-single-frame';
  const shortRecording = timeline.mode === 'hold-last-frame';
  const staticRecording = singleFrame;
  if (!width || !height || !Number.isFinite(origin)) throw new Error('ffprobe returned incomplete video metadata');
  const tracks = buildTouchTracks(manifest.actions, {
    origin,
    duration,
    videoWidth: width,
    videoHeight: height,
    windowWidth: Number(manifest.window.width),
    windowHeight: Number(manifest.window.height),
  });
  if (!tracks.length) return { status: 'SKIPPED', reason: 'No touches fell inside the recorded timeline' };
  writeTouchIndicator(indicatorFile);
  const labels = tracks.map((_, index) => `[dot${index}]`).join('');
  const filters = [];
  if (singleFrame) {
    filters.push('[0:v]loop=loop=-1:size=1:start=0,setpts=N/30/TB[base]');
  } else if (shortRecording) {
    // Keep the frames that exist and hold the last one for the rest of the run,
    // rather than looping the first: the screen really did stay as it ended.
    filters.push('[0:v]fps=30,setpts=PTS-STARTPTS,'
      + `tpad=stop_mode=clone:stop_duration=${timeline.padSeconds}[base]`);
  } else {
    filters.push('[0:v]fps=30,setpts=PTS-STARTPTS[base]');
  }
  if (tracks.length === 1) filters.push(`[1:v]format=rgba${labels}`);
  else filters.push(`[1:v]format=rgba,split=${tracks.length}${labels}`);
  let input = '[base]';
  tracks.forEach((track, index) => {
    const output = `[touch${index}]`;
    filters.push(`${input}[dot${index}]overlay=x='${coordinateExpression(track, 'x')}':y='${coordinateExpression(track, 'y')}':enable='between(t,${track.visibleStart.toFixed(3)},${track.visibleEnd.toFixed(3)})':eof_action=pass${output}`);
    input = output;
  });
  const rendered = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', videoFile,
    '-loop', '1', '-framerate', '30', '-i', indicatorFile,
    '-filter_complex', filters.join(';'), '-map', input, '-map', '0:a?',
    '-t', String(duration), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '28',
    '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', '-y', outputFile,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (rendered.status !== 0) throw new Error(`ffmpeg touch overlay failed: ${rendered.stderr.trim()}`);
  return {
    status: 'COMPLETE',
    events: tracks.map((track) => ({
      kind: track.kind,
      action: track.action,
      startSeconds: track.visibleStart,
      endSeconds: track.visibleEnd,
      points: track.points.map(({ kind, x, y, at, seconds }) => ({ kind, x, y, at, seconds })),
    })),
    touchVideo: path.basename(outputFile),
    staticSourceExtended: timeline.extended,
    timelineMode: timeline.mode,
    sourceFrames: Number.isFinite(sourceFrames) ? sourceFrames : null,
    sourceDurationSeconds: Number.isFinite(recordedDuration) ? Number(recordedDuration.toFixed(3)) : null,
    timelineSeconds: Number(duration.toFixed(3)),
    outputFrameRate: 30,
    tracking: 'continuous-linear',
    compression: { codec: 'h264', preset: 'medium', crf: 28, fastStart: true },
  };
}

async function capture(driver, outputDir, sequence, name, manifest) {
  const file = path.join(outputDir, `${String(sequence).padStart(3, '0')}-${slug(name)}.png`);
  const png = await driver.takeScreenshot();
  writeFileSync(file, Buffer.from(png, 'base64'), { mode: 0o600 });
  const artifact = { type: 'screenshot', name, file: path.basename(file), sha256: sha256(file), at: new Date().toISOString() };
  manifest.artifacts.push(artifact);
  return artifact;
}

function parseHexColor(value) {
  if (!/^#[0-9a-f]{6}$/i.test(value ?? '')) throw new Error(`Invalid marker color: ${value}`);
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function countColorPixels(png, target, tolerance) {
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (
      Math.abs(png.data[offset] - target[0]) <= tolerance
      && Math.abs(png.data[offset + 1] - target[1]) <= tolerance
      && Math.abs(png.data[offset + 2] - target[2]) <= tolerance
      && png.data[offset + 3] >= 200
    ) count += 1;
  }
  return count;
}

function colorCentroid(png, color, scale, tolerance = 35) {
  if (!color) return null;
  const target = parseHexColor(color);
  let pixels = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      if (
        Math.abs(png.data[offset] - target[0]) <= tolerance
        && Math.abs(png.data[offset + 1] - target[1]) <= tolerance
        && Math.abs(png.data[offset + 2] - target[2]) <= tolerance
        && png.data[offset + 3] >= 200
      ) {
        pixels += 1;
        sumX += x;
        sumY += y;
      }
    }
  }
  if (!pixels) return null;
  return { xPoints: sumX / pixels / scale, yPoints: sumY / pixels / scale, pixels };
}

async function waitForVisibleColor(driver, action) {
  const target = parseHexColor(action.color);
  const tolerance = Number(action.tolerance ?? 35);
  const minPixels = Number(action.minPixels ?? 100);
  const consecutiveMatches = Number(action.consecutiveMatches ?? 2);
  const timeoutMs = Number(action.timeoutMs ?? 15000);
  const intervalMs = Number(action.intervalMs ?? 120);
  const started = Date.now();
  let polls = 0;
  let consecutive = 0;
  let maximumPixels = 0;
  while (Date.now() - started < timeoutMs) {
    const encoded = await driver.takeScreenshot();
    const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
    const matchingPixels = countColorPixels(png, target, tolerance);
    maximumPixels = Math.max(maximumPixels, matchingPixels);
    polls += 1;
    consecutive = matchingPixels >= minPixels ? consecutive + 1 : 0;
    if (consecutive >= consecutiveMatches) {
      return { color: action.color.toLowerCase(), matchingPixels, maximumPixels, polls, elapsedMs: Date.now() - started };
    }
    await driver.pause(intervalMs);
  }
  throw new Error(`Visible marker ${action.name ?? action.color} did not appear within ${timeoutMs}ms (max pixels ${maximumPixels}, required ${minPixels})`);
}

async function tapRelativeToVisibleColor(driver, action, rect) {
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const anchor = colorCentroid(png, action.color, scale, Number(action.tolerance ?? 35));
  const minPixels = Number(action.minPixels ?? 100);
  if (!anchor || anchor.pixels < minPixels) throw new Error(`Relative-tap marker ${action.color} is not visibly present`);
  const x = Math.round(anchor.xPoints + Number(action.offsetX ?? 0));
  const y = Math.round(anchor.yPoints + Number(action.offsetY ?? 0));
  checkPoint(x, rect.width, 'relative tap x');
  checkPoint(y, rect.height, 'relative tap y');
  const touch = action.engine === 'mobile'
    ? await (async () => { const at = new Date().toISOString(); await driver.execute('mobile: tap', { x, y }); return { kind: 'tap', x, y, at }; })()
    : await nativeTap(driver, x, y);
  return { color: action.color.toLowerCase(), anchor, resolved: { x, y }, touch };
}

// Scrolling anchored to a marker instead of a literal start point. The start of a
// scroll matters more than it looks: a fixed coordinate calibrated in a browser lands
// on the browser's own chrome in a web view, so the page never receives the gesture.
async function swipeRelativeToVisibleColorByOffset(driver, rawAction, rect) {
  // deltaYFraction/deltaXFraction scale the displacement to the window, so a case
  // that reaches the list edge here reaches it on a shorter screen too.
  const action = resolveWindowFractions(rawAction, rect);
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const anchor = colorCentroid(png, action.color, scale, Number(action.tolerance ?? 35));
  const minPixels = Number(action.minPixels ?? 100);
  if (!anchor || anchor.pixels < minPixels) throw new Error(`Relative-offset swipe marker ${action.color} is not visibly present`);
  const swipe = {
    fromX: Math.round(anchor.xPoints + Number(action.offsetX ?? 0)),
    fromY: Math.round(anchor.yPoints + Number(action.offsetY ?? 0)),
    toX: Math.round(anchor.xPoints + Number(action.offsetX ?? 0) + Number(action.deltaX ?? 0)),
    toY: Math.round(anchor.yPoints + Number(action.offsetY ?? 0) + Number(action.deltaY ?? 0)),
    durationMs: action.durationMs,
    settleMs: action.settleMs,
  };
  for (const [key, max] of [['fromX', rect.width], ['toX', rect.width], ['fromY', rect.height], ['toY', rect.height]]) {
    checkPoint(swipe[key], max, `relative-offset swipe ${key}`);
  }
  const touches = await nativeSwipe(driver, swipe);
  return { color: action.color.toLowerCase(), anchor, resolved: { fromX: swipe.fromX, fromY: swipe.fromY, toX: swipe.toX, toY: swipe.toY }, touches };
}

// Text goes in through the platform's own input path — see text-entry.mjs for why
// tapping keyboard keys cannot port between surfaces.
async function typeTextOnDevice(driver, action, device) {
  const text = String(action.text ?? '');
  const at = new Date().toISOString();
  if (platformName(device) === 'Android') {
    const args = androidInputTextCommand(text);
    const attempt = adbAttempt(device.udid, args, 30000);
    if (!attempt.ok) throw new Error(`typeText failed: ${attempt.output || 'adb input text returned non-zero'}`);
  } else {
    await driver.keys(text.split(''));
  }
  if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
  return { kind: 'text', text, at, completedAt: new Date().toISOString() };
}

async function pressEditorKey(driver, action, device) {
  const key = String(action.key ?? '');
  const at = new Date().toISOString();
  if (platformName(device) === 'Android') {
    const attempt = adbAttempt(device.udid, androidKeyeventCommand(key), 20000);
    if (!attempt.ok) throw new Error(`pressKey ${key} failed: ${attempt.output || 'adb keyevent returned non-zero'}`);
  } else {
    await driver.keys([iosKeySequence(key)]);
  }
  if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
  return { kind: 'key', key, at, completedAt: new Date().toISOString() };
}

// A numeric keyboard has no Return key, so cases that need it gone tapped a blank
// spot on the page — a coordinate that only stays blank on the surface it was picked
// on. Both platforms can be asked directly instead.
async function hideDeviceKeyboard(driver, action, device) {
  const at = new Date().toISOString();
  if (platformName(device) === 'Android') {
    // BACK closes the IME, but with no IME up it navigates the browser back (in the
    // web-view shell, it finishes the activity), so ask before pressing.
    const state = adbAttempt(device.udid, ['shell', 'dumpsys input_method'], 20000);
    const shown = /mInputShown=true/.test(state.output);
    if (shown) {
      const attempt = adbAttempt(device.udid, androidKeyeventCommand('back'), 20000);
      if (!attempt.ok) throw new Error(`hideKeyboard failed: ${attempt.output || 'adb keyevent returned non-zero'}`);
    }
    if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
    return { kind: 'hide-keyboard', pressed: shown, at, completedAt: new Date().toISOString() };
  }
  // iOS has no dumpsys, but WDA reports keyboard visibility directly. hideKeyboard()
  // alone is not enough: from iOS 26 it raises "Did not know how to dismiss the
  // keyboard" for Safari's web keyboards, which carry no dismiss key of their own.
  // The form accessory bar above them does, and it is a separate element, so it is
  // asked first; hideKeyboard stays the fallback for the app UIs and web views that
  // still answer it. Only a keyboard that survives both is an error.
  if (!(await driver.isKeyboardShown())) {
    if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
    return { kind: 'hide-keyboard', pressed: false, at, completedAt: new Date().toISOString() };
  }
  // iOS 26 has no safe programmatic dismissal for Safari's web keyboards, and the
  // obvious workaround is worse than the failure. Tapping the form accessory bar's
  // Done DOES dismiss, but it tells WebKit the user is finished with form input and
  // the NEXT raise is then torn down ~200ms after it opens: the keyboard visibly
  // appears, the visual viewport shrinks, and Safari blurs the viewer's proxy with no
  // JS blur() anywhere in the stack. Every later keystroke is silently lost and the
  // session wedges, which grades as a product FAIL — a harness action inventing a
  // defect in the thing it is measuring. Tapping outside does not help either: the
  // LiveView keyboard belongs to the viewer's hidden proxy, and only a tap the viewer
  // itself classifies as a non-input 'miss' calls its dismissKeyboard.
  //
  // So fail loudly instead. An INFRA_ERROR that names the limitation is honest; a
  // dismissal that poisons the rest of the run is not.
  let via = null;
  try {
    await driver.hideKeyboard();
    via = 'wda-hide-keyboard';
  } catch (error) {
    throw new Error(
      `hideKeyboard is not available on this iOS build (${error.message.split('\n')[0]}). `
      + 'Do NOT substitute a tap on the keyboard accessory bar\'s Done button: it dismisses, '
      + 'but WebKit then tears down the next keyboard ~200ms after it opens and every '
      + 'subsequent keystroke is lost. The case needs a dismissal the viewer performs itself.',
    );
  }
  await driver.pause(Math.max(0, Number(action.settleMs ?? 250)));
  if (await driver.isKeyboardShown()) throw new Error(`hideKeyboard failed: keyboard still shown (${via})`);
  return { kind: 'hide-keyboard', pressed: true, via, at, completedAt: new Date().toISOString() };
}

// Native pickers are OS windows with no fixture colors in them, so they are addressed
// by accessibility text. That is stable across browsers and web views, which literal
// wheel coordinates are not.
// Android has no WebDriver here (the transport is adb screencap + adb input), so a
// native element is resolved from the accessibility hierarchy and then tapped like any
// other point. uiautomator's own scrollIntoView needs a WebDriver, so a list is walked
// by repeating a swipe inside the list's own rectangle until the row appears.
async function tapAndroidNativeElement(driver, action, device) {
  const spec = action.android;
  if (!spec || typeof spec !== 'object') throw new Error('tapNativeElement requires an android selector');
  const dumpPath = '/sdcard/popcorn-harness-ui.xml';
  const readHierarchy = () => {
    // Remove the previous dump first: if this one fails, the read must fail too rather
    // than resolve a tap against a stale hierarchy.
    adbAttempt(device.udid, ['shell', 'rm', '-f', dumpPath], 20000);
    // `uiautomator dump` waits for the window to go idle and can outlive its own
    // success message while a picker wheel is still animating, so its exit status is
    // not the signal — whether the file parses is.
    adbAttempt(device.udid, ['shell', 'uiautomator', 'dump', dumpPath], 60000);
    const read = adbAttempt(device.udid, ['shell', 'cat', dumpPath], 30000);
    const xml = read.output ?? '';
    if (!xml.includes('<hierarchy')) {
      throw new Error(`could not read the accessibility hierarchy: ${xml.slice(0, 200) || 'empty dump'}`);
    }
    return xml;
  };
  // Let a wheel or dialog animation finish, both so the dump can go idle and so the
  // resolved rectangle is where the element comes to rest.
  await driver.pause(Number(action.dumpSettleMs ?? 350));
  const maxScrolls = spec.scroll ? Number(action.maxScrolls ?? 40) : 0;
  const at = new Date().toISOString();
  let scrolls = 0;
  for (;;) {
    const xml = readHierarchy();
    const target = resolveTapTarget(xml, spec);
    if (target.found) {
      const touch = await nativeTap(driver, target.point.x, target.point.y);
      if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
      return {
        kind: 'native-tap', selector: describeSpec(spec), scrolls,
        resolved: target.point, matches: target.matches, at, completedAt: new Date().toISOString(), touch,
      };
    }
    if (scrolls >= maxScrolls) {
      throw new Error(`native element ${describeSpec(spec)} not found`
        + (target.matches ? ` (${target.matches} match(es) present but off screen)` : '')
        + (maxScrolls ? ` after ${scrolls} scroll(s)` : ''));
    }
    const gesture = scrollGestureFor(xml, { direction: spec.scrollDirection ?? 'down' });
    if (!gesture) throw new Error(`native element ${describeSpec(spec)} not found and nothing on screen scrolls`);
    await nativeSwipe(driver, gesture);
    scrolls += 1;
  }
}

async function tapNativeElement(driver, action, device) {
  const platform = platformName(device);
  if (platform === 'Android') return tapAndroidNativeElement(driver, action, device);
  // A <select> is a list of tappable rows on Android but a spinning wheel on iOS, and
  // a wheel is set by value rather than tapped: its rows are not separate elements.
  if (platform === 'iOS' && action.ios?.pickerValue) {
    const at = new Date().toISOString();
    // A date or time control is several wheels side by side, so a value has to say
    // which one it belongs to; the first wheel is not always the right one.
    const index = Number(action.ios.wheelIndex ?? 1);
    if (!Number.isInteger(index) || index < 1) throw new Error(`ios.wheelIndex must be a 1-based index, got ${action.ios.wheelIndex}`);
    const wheel = await driver.$(`-ios class chain:**/XCUIElementTypePickerWheel[${index}]`);
    await wheel.waitForDisplayed({ timeout: Number(action.timeoutMs ?? 10000), timeoutMsg: 'native picker wheel never appeared' });
    await wheel.setValue(String(action.ios.pickerValue));
    if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
    return { kind: 'native-picker', value: String(action.ios.pickerValue), wheelIndex: index, at, completedAt: new Date().toISOString() };
  }
  const selector = nativeElementSelector(action, platform);
  const timeout = Number(action.timeoutMs ?? 10000);
  const at = new Date().toISOString();
  const element = await driver.$(selector);
  await element.waitForDisplayed({ timeout, timeoutMsg: `native element ${selector} never appeared` });
  await element.click();
  if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
  return { kind: 'native-tap', selector, at, completedAt: new Date().toISOString() };
}

async function dragRelativeToVisibleColors(driver, action, rect) {
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const tolerance = Number(action.tolerance ?? 35);
  const minPixels = Number(action.minPixels ?? 100);
  const source = colorCentroid(png, action.sourceColor, scale, tolerance);
  const target = colorCentroid(png, action.targetColor, scale, tolerance);
  if (!source || source.pixels < minPixels) throw new Error(`Relative-drag source marker ${action.sourceColor} is not visibly present`);
  if (!target || target.pixels < minPixels) throw new Error(`Relative-drag target marker ${action.targetColor} is not visibly present`);
  const drag = {
    fromX: Math.round(source.xPoints + Number(action.sourceOffsetX ?? 0)),
    fromY: Math.round(source.yPoints + Number(action.sourceOffsetY ?? 0)),
    toX: Math.round(target.xPoints + Number(action.targetOffsetX ?? 0)),
    toY: Math.round(target.yPoints + Number(action.targetOffsetY ?? 0)),
    durationMs: action.durationMs,
    holdMs: action.holdMs,
    releasePauseMs: action.releasePauseMs,
    steps: action.steps,
  };
  for (const [key, max] of [['fromX', rect.width], ['toX', rect.width], ['fromY', rect.height], ['toY', rect.height]]) {
    checkPoint(drag[key], max, `relative drag ${key}`);
  }
  const touches = await nativeDrag(driver, drag);
  return {
    sourceColor: action.sourceColor.toLowerCase(),
    targetColor: action.targetColor.toLowerCase(),
    source,
    target,
    resolved: { fromX: drag.fromX, fromY: drag.fromY, toX: drag.toX, toY: drag.toY },
    touches,
  };
}

async function dragRelativeToVisibleColorByOffset(driver, action, rect) {
  action = resolveWindowFractions(action, rect); // see swipeRelativeToVisibleColorByOffset
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const source = colorCentroid(png, action.sourceColor, scale, Number(action.tolerance ?? 35));
  const minPixels = Number(action.minPixels ?? 100);
  if (!source || source.pixels < minPixels) throw new Error(`Relative-offset drag source marker ${action.sourceColor} is not visibly present`);
  const drag = {
    fromX: Math.round(source.xPoints + Number(action.sourceOffsetX ?? 0)),
    fromY: Math.round(source.yPoints + Number(action.sourceOffsetY ?? 0)),
    toX: Math.round(source.xPoints + Number(action.sourceOffsetX ?? 0) + Number(action.deltaX ?? 0)),
    toY: Math.round(source.yPoints + Number(action.sourceOffsetY ?? 0) + Number(action.deltaY ?? 0)),
    durationMs: action.durationMs, holdMs: action.holdMs, releasePauseMs: action.releasePauseMs, steps: action.steps,
  };
  for (const [key, max] of [['fromX', rect.width], ['toX', rect.width], ['fromY', rect.height], ['toY', rect.height]]) checkPoint(drag[key], max, `relative-offset drag ${key}`);
  const touches = await nativeDrag(driver, drag);
  return { sourceColor: action.sourceColor.toLowerCase(), source, resolved: { fromX: drag.fromX, fromY: drag.fromY, toX: drag.toX, toY: drag.toY }, touches };
}

async function swipeRelativeToVisibleColors(driver, action, rect) {
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const tolerance = Number(action.tolerance ?? 35);
  const minPixels = Number(action.minPixels ?? 100);
  const source = colorCentroid(png, action.sourceColor, scale, tolerance);
  const target = colorCentroid(png, action.targetColor, scale, tolerance);
  if (!source || source.pixels < minPixels) throw new Error(`Relative-swipe source marker ${action.sourceColor} is not visibly present`);
  if (!target || target.pixels < minPixels) throw new Error(`Relative-swipe target marker ${action.targetColor} is not visibly present`);
  const swipe = {
    fromX: Math.round(source.xPoints + Number(action.sourceOffsetX ?? 0)),
    fromY: Math.round(source.yPoints + Number(action.sourceOffsetY ?? 0)),
    toX: Math.round(target.xPoints + Number(action.targetOffsetX ?? 0)),
    toY: Math.round(target.yPoints + Number(action.targetOffsetY ?? 0)),
    durationMs: action.durationMs,
  };
  for (const [key, max] of [['fromX', rect.width], ['toX', rect.width], ['fromY', rect.height], ['toY', rect.height]]) {
    checkPoint(swipe[key], max, `relative swipe ${key}`);
  }
  return {
    sourceColor: action.sourceColor.toLowerCase(), targetColor: action.targetColor.toLowerCase(),
    source, target, resolved: { fromX: swipe.fromX, fromY: swipe.fromY, toX: swipe.toX, toY: swipe.toY },
    touches: await nativeSwipe(driver, swipe),
  };
}

async function repeatedTapRelativeToVisibleColor(driver, action, rect) {
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const anchor = colorCentroid(png, action.color, scale, Number(action.tolerance ?? 35));
  const minPixels = Number(action.minPixels ?? 100);
  if (!anchor || anchor.pixels < minPixels) throw new Error(`Repeated-tap marker ${action.color} is not visibly present`);
  const x = Math.round(anchor.xPoints + Number(action.offsetX ?? 0));
  const y = Math.round(anchor.yPoints + Number(action.offsetY ?? 0));
  checkPoint(x, rect.width, 'repeated tap x');
  checkPoint(y, rect.height, 'repeated tap y');
  const count = Math.max(2, Math.min(20, Math.round(Number(action.count ?? 2))));
  if (action.singleSequence) {
    const touches = await nativeRepeatedTap(driver, x, y, count, Number(action.intervalMs ?? 80));
    return { color: action.color.toLowerCase(), anchor, resolved: { x, y }, count, singleSequence: true, touches };
  }
  const touches = [];
  for (let index = 0; index < count; index += 1) {
    touches.push(await nativeTap(driver, x, y));
    if (index + 1 < count) await driver.pause(Math.max(0, Number(action.intervalMs ?? 80)));
  }
  return { color: action.color.toLowerCase(), anchor, resolved: { x, y }, count, touches };
}

async function doubleTapRelativeToVisibleColor(driver, action, rect) {
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const anchor = colorCentroid(png, action.color, scale, Number(action.tolerance ?? 35));
  const minPixels = Number(action.minPixels ?? 100);
  if (!anchor || anchor.pixels < minPixels) throw new Error(`Double-tap marker ${action.color} is not visibly present`);
  const x = Math.round(anchor.xPoints + Number(action.offsetX ?? 0));
  const y = Math.round(anchor.yPoints + Number(action.offsetY ?? 0));
  checkPoint(x, rect.width, 'double tap x');
  checkPoint(y, rect.height, 'double tap y');
  const at = new Date().toISOString();
  const driverPlatform = String(driver.capabilities?.platformName ?? '').toLowerCase();
  if (driverPlatform === 'android') await driver.execute('mobile: doubleClickGesture', { x, y });
  else await driver.execute('mobile: doubleTap', { x, y });
  return { color: action.color.toLowerCase(), anchor, resolved: { x, y }, touches: [{ kind: 'tap', x, y, at }, { kind: 'tap', x, y, at: new Date().toISOString() }] };
}

async function pinchRelativeToVisibleColor(driver, action, rect) {
  const encoded = await driver.takeScreenshot();
  const png = PNG.sync.read(Buffer.from(encoded, 'base64'));
  const scale = png.width / rect.width;
  const anchor = colorCentroid(png, action.color, scale, Number(action.tolerance ?? 35));
  const minPixels = Number(action.minPixels ?? 100);
  if (!anchor || anchor.pixels < minPixels) throw new Error(`Pinch marker ${action.color} is not visibly present`);
  const pinch = {
    centerX: Math.round(anchor.xPoints + Number(action.offsetX ?? 0)),
    centerY: Math.round(anchor.yPoints + Number(action.offsetY ?? 0)),
    startRadius: Math.max(8, Number(action.startRadius ?? 28)),
    endRadius: Math.max(8, Number(action.endRadius ?? 100)),
    durationMs: action.durationMs, holdMs: action.holdMs, steps: action.steps,
  };
  checkPoint(pinch.centerX - Math.max(pinch.startRadius, pinch.endRadius), rect.width, 'pinch left x');
  checkPoint(pinch.centerX + Math.max(pinch.startRadius, pinch.endRadius), rect.width, 'pinch right x');
  checkPoint(pinch.centerY, rect.height, 'pinch y');
  return { color: action.color.toLowerCase(), anchor, resolved: pinch, touches: await nativePinch(driver, pinch) };
}

function checkPoint(value, maximum, label) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${label}=${value} is outside native window bounds 0..${maximum}`);
  }
}

async function runSetupActions(driver, actions, rect, manifest, manifestFile, device) {
  manifest.setupActions = [];
  for (const [index, action] of (actions ?? []).entries()) {
    const record = { index, ...action, startedAt: new Date().toISOString(), completedAt: null, status: 'RUNNING' };
    manifest.setupActions.push(record);
    saveManifest(manifestFile, manifest);
    try {
      switch (action.type) {
        case 'wait':
          await driver.pause(Number(action.ms ?? 500));
          break;
        case 'waitForColor':
          record.observation = await waitForVisibleColor(driver, action);
          break;
        case 'tap':
          checkPoint(action.x, rect.width, 'setup tap x');
          checkPoint(action.y, rect.height, 'setup tap y');
          record.touch = await nativeTap(driver, Math.round(action.x), Math.round(action.y));
          if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
          break;
        case 'tapRelativeToColor':
          record.observation = await tapRelativeToVisibleColor(driver, action, rect);
          record.touch = record.observation.touch;
          break;
        case 'swipe': {
          const swipe = resolveWindowFractions(action, rect);
          for (const [key, max] of [['fromX', rect.width], ['toX', rect.width], ['fromY', rect.height], ['toY', rect.height]]) {
            checkPoint(swipe[key], max, `setup ${key}`);
          }
          record.resolved = { fromX: swipe.fromX, fromY: swipe.fromY, toX: swipe.toX, toY: swipe.toY };
          record.touches = await nativeSwipe(driver, swipe);
          break;
        }
        case 'dragRelativeToColors':
          record.observation = await dragRelativeToVisibleColors(driver, action, rect);
          record.touches = record.observation.touches;
          break;
        case 'dragRelativeToColorByOffset':
          record.observation = await dragRelativeToVisibleColorByOffset(driver, action, rect);
          record.touches = record.observation.touches;
          break;
        case 'swipeRelativeToColors':
          record.observation = await swipeRelativeToVisibleColors(driver, action, rect);
          record.touches = record.observation.touches;
          break;
        case 'repeatedTapRelativeToColor':
          record.observation = await repeatedTapRelativeToVisibleColor(driver, action, rect);
          record.touches = record.observation.touches;
          break;
        case 'doubleTapRelativeToColor':
          record.observation = await doubleTapRelativeToVisibleColor(driver, action, rect);
          record.touches = record.observation.touches;
          break;
        case 'pinchRelativeToColor':
          record.observation = await pinchRelativeToVisibleColor(driver, action, rect);
          record.touches = record.observation.touches;
          break;
        case 'swipeRelativeToColorByOffset':
          record.observation = await swipeRelativeToVisibleColorByOffset(driver, action, rect);
          record.touches = record.observation.touches;
          break;
        case 'typeText':
          record.entry = await typeTextOnDevice(driver, action, device);
          break;
        case 'pressKey':
          record.entry = await pressEditorKey(driver, action, device);
          break;
        case 'tapNativeElement':
          record.entry = await tapNativeElement(driver, action, device);
          break;
        case 'hideKeyboard':
          record.entry = await hideDeviceKeyboard(driver, action, device);
          break;
        default:
          throw new Error(`Unsupported setup action type: ${action.type}`);
      }
      record.status = 'OK';
    } catch (error) {
      record.status = 'ERROR';
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      record.completedAt = new Date().toISOString();
      saveManifest(manifestFile, manifest);
    }
  }
}

async function runScenario(scenarioFile, outputOverride, quiet = false) {
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
  scenario.url = resolveScenarioUrl(scenario, scenarioFile);
  if (!scenario.name || !scenario.device?.udid) {
    throw new Error('Scenario requires name and device.udid');
  }
  const outputDir = path.resolve(outputOverride || path.join(root, 'artifacts', slug(scenario.name)));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(outputDir, 'run.json');
  const manifest = {
    schemaVersion: 1,
    name: scenario.name,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'RUNNING',
    verdict: 'REVIEW',
    reason: 'Awaiting pixel-based evidence review',
    url: redactUrl(scenario.url),
    caseId: scenario.caseId ?? null,
    testDescription: scenario.testDescription ?? null,
    testPage: scenario.testPage ?? null,
    device: scenario.device,
    browser: { name: browserName(scenario.device, scenario.launchTarget), platformName: platformName(scenario.device) },
    launchTarget: null,
    window: null,
    setupActions: [],
    recordingStart: null,
    actions: [],
    artifacts: [],
  };
  saveManifest(manifestFile, manifest);

  const port = Number(scenario.appiumPort ?? 4723);
  const appiumLog = path.join(outputDir, 'appium.log');
  const videoFile = path.join(outputDir, 'screen.mp4');
  const touchVideoFile = path.join(outputDir, 'screen-touches.mp4');
  const touchIndicatorFile = path.join(outputDir, 'touch-indicator.png');
  let appium;
  let video;
  let driver;
  let screenshotSequence = 1;
  let postRunError;

  try {
    manifest.devicePreflight = bootedMobileDevice(scenario.device);
    saveManifest(manifestFile, manifest);
    const mobilePlatform = platformName(scenario.device);
    const launchTarget = {
      ...defaultLaunchTarget(mobilePlatform),
      ...(scenario.launchTarget ?? {}),
    };
    // Install before the session starts: on iOS the session attaches to the
    // target bundle, which has to exist first.
    manifest.launchTarget = ensureLaunchTarget(mobilePlatform, scenario.device.udid, launchTarget);
    saveManifest(manifestFile, manifest);
    if (mobilePlatform === 'Android') {
      prepareAndroidNativeInput(scenario.device.udid);
      driver = await createAndroidAdbTransport(scenario.device.udid);
      manifest.transport = {
        kind: 'adb-native',
        screenshots: 'adb-exec-out-screencap',
        touches: 'adb-shell-input',
        elementAccess: false,
        webdriverConnection: false,
      };
    } else {
      appium = startAppium(port, appiumLog);
      await waitForServer(port, appium);
      const capabilities = {
        platformName: mobilePlatform,
        'appium:automationName': 'XCUITest',
        'appium:udid': scenario.device.udid,
        'appium:deviceName': scenario.device.name,
        'appium:platformVersion': scenario.device.platformVersion,
        'appium:newCommandTimeout': 180,
        'appium:noReset': true,
      };
      Object.assign(capabilities, {
        'appium:connectHardwareKeyboard': false,
        'appium:showXcodeLog': true,
        'appium:wdaLaunchTimeout': 120000,
        'appium:webviewConnectTimeout': Number(scenario.webviewConnectTimeout ?? 20000),
      });
      // Safari is addressed as a browser; any other host app is addressed by
      // bundle id, and receives its URL from the launch step below.
      if (launchTarget.browserName) {
        capabilities.browserName = launchTarget.browserName;
        capabilities['appium:safariInitialUrl'] = scenario.url;
      } else {
        capabilities['appium:bundleId'] = launchTarget.bundleId;
      }
      if (scenario.wdaLocalPort) capabilities['appium:wdaLocalPort'] = Number(scenario.wdaLocalPort);
      if (scenario.mjpegServerPort) capabilities['appium:mjpegServerPort'] = Number(scenario.mjpegServerPort);
      if (scenario.derivedDataPath) capabilities['appium:derivedDataPath'] = scenario.derivedDataPath;
      const { remote } = await import('webdriverio');
      driver = await remote({
        hostname: '127.0.0.1',
        port,
        path: '/',
        logLevel: 'warn',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
      });
      const contexts = await driver.getContexts();
      if (contexts.includes('NATIVE_APP')) await driver.switchContext('NATIVE_APP');
      manifest.transport = { kind: 'appium-xcuitest', elementAccess: false };
    }
    if (scenario.nativeOpenUrl) {
      // Session setup can restart the device — Appium restarts a simulator that
      // was booted without its UI — so confirm the host app is still there
      // rather than failing on an opaque launch error.
      manifest.launchTarget = {
        // Keep the install evidence recorded before the session started; the
        // confirmation only reports what it found.
        ...manifest.launchTarget,
        ...ensureLaunchTarget(mobilePlatform, scenario.device.udid, launchTarget),
        confirmedBeforeLaunch: true,
      };
      saveManifest(manifestFile, manifest);
      if (mobilePlatform === 'Android') {
        const preparation = prepareAndroidLaunchTarget(scenario.device.udid, launchTarget);
        if (preparation) {
          manifest.launchTarget.preparation = preparation;
          saveManifest(manifestFile, manifest);
        }
        adbCommand(scenario.device.udid, ['shell', 'am', 'force-stop', launchTarget.package], `Reset ${launchTarget.label}`);
        await driver.pause(500);
      }
      const opened = mobilePlatform === 'Android'
        ? spawnSync('adb', ['-s', scenario.device.udid, 'shell', androidLaunchCommand(launchTarget, scenario.url)], { encoding: 'utf8' })
        : spawnSync('xcrun', iosLaunchArgv(launchTarget, scenario.url, scenario.device.udid), { encoding: 'utf8' });
      if (opened.status !== 0) {
        throw new Error(`${mobilePlatform === 'Android' ? 'adb' : 'simctl'} ${launchTarget.label} open failed: ${(opened.stderr || opened.stdout || '').trim()}`);
      }
      manifest.navigation = {
        method: `${mobilePlatform === 'Android' ? 'adb' : 'simctl'}-${launchTarget.name}-${launchTarget.urlDelivery}`,
        url: redactUrl(scenario.url),
      };
    }
    const rect = await driver.getWindowRect();
    manifest.window = rect;
    saveManifest(manifestFile, manifest);
    await driver.pause(Number(scenario.settleMs ?? 8000));

    if (mobilePlatform === 'Android') {
      const dismissed = await dismissAndroidLaunchDialogs(driver, scenario.device.udid, launchTarget);
      if (dismissed.length) {
        manifest.launchTarget.dismissedDialogs = dismissed;
        saveManifest(manifestFile, manifest);
      }
    }

    await runSetupActions(driver, scenario.setupActions, rect, manifest, manifestFile, scenario.device);
    if (scenario.recordingStart) {
      manifest.recordingStart = {
        ...scenario.recordingStart,
        startedAt: new Date().toISOString(),
        status: 'RUNNING',
      };
      saveManifest(manifestFile, manifest);
      try {
        manifest.recordingStart.observation = await waitForVisibleColor(driver, scenario.recordingStart);
        manifest.recordingStart.status = 'OK';
      } catch (error) {
        manifest.recordingStart.status = 'ERROR';
        manifest.recordingStart.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        manifest.recordingStart.completedAt = new Date().toISOString();
        saveManifest(manifestFile, manifest);
      }
    }
    video = await startMobileVideo(scenario.device, videoFile);
    manifest.video = {
      file: 'screen.mp4',
      startedAt: video.recordingStartedAt,
      startsAfterCaseReady: Boolean(scenario.recordingStart),
      touchOverlay: 'PENDING',
    };
    saveManifest(manifestFile, manifest);
    await driver.pause(Number(scenario.recordingLeadInMs ?? 350));

    for (const [index, action] of (scenario.actions ?? []).entries()) {
      const record = { index, ...action, startedAt: new Date().toISOString(), completedAt: null, status: 'RUNNING' };
      manifest.actions.push(record);
      saveManifest(manifestFile, manifest);
      // A materialized pair has already dropped the other platform's actions; a
      // hand-written scenario has not, and running one would touch the wrong thing.
      if (!runsOnPlatform(action, platformName(scenario.device))) {
        record.status = 'SKIPPED';
        record.completedAt = new Date().toISOString();
        saveManifest(manifestFile, manifest);
        continue;
      }
      try {
        switch (action.type) {
          case 'wait':
            await driver.pause(Number(action.ms ?? 500));
            break;
          case 'screenshot':
            record.artifact = await capture(driver, outputDir, screenshotSequence++, action.name ?? `step-${index}`, manifest);
            break;
          case 'waitForColor':
            record.observation = await waitForVisibleColor(driver, action);
            break;
          case 'tap':
            checkPoint(action.x, rect.width, 'x');
            checkPoint(action.y, rect.height, 'y');
            record.touches = [await nativeTap(driver, Math.round(action.x), Math.round(action.y))];
            if (action.settleMs) await driver.pause(Math.max(0, Number(action.settleMs)));
            break;
          case 'tapRelativeToColor':
            record.observation = await tapRelativeToVisibleColor(driver, action, rect);
            record.touches = [record.observation.touch];
            break;
          case 'swipe': {
            const swipe = resolveWindowFractions(action, rect);
            for (const [key, max] of [['fromX', rect.width], ['toX', rect.width], ['fromY', rect.height], ['toY', rect.height]]) {
              checkPoint(swipe[key], max, key);
            }
            record.resolved = { fromX: swipe.fromX, fromY: swipe.fromY, toX: swipe.toX, toY: swipe.toY };
            record.touches = await nativeSwipe(driver, swipe);
            break;
          }
          case 'dragRelativeToColors':
            record.observation = await dragRelativeToVisibleColors(driver, action, rect);
            record.touches = record.observation.touches;
            break;
          case 'dragRelativeToColorByOffset':
            record.observation = await dragRelativeToVisibleColorByOffset(driver, action, rect);
            record.touches = record.observation.touches;
            break;
          case 'swipeRelativeToColors':
            record.observation = await swipeRelativeToVisibleColors(driver, action, rect);
            record.touches = record.observation.touches;
            break;
          case 'repeatedTapRelativeToColor':
            record.observation = await repeatedTapRelativeToVisibleColor(driver, action, rect);
            record.touches = record.observation.touches;
            break;
          case 'doubleTapRelativeToColor':
            record.observation = await doubleTapRelativeToVisibleColor(driver, action, rect);
            record.touches = record.observation.touches;
            break;
          case 'pinchRelativeToColor':
            record.observation = await pinchRelativeToVisibleColor(driver, action, rect);
            record.touches = record.observation.touches;
            break;
          case 'rotate':
            if (!['PORTRAIT', 'LANDSCAPE'].includes(action.orientation)) throw new Error('rotate orientation must be PORTRAIT or LANDSCAPE');
            await driver.setOrientation(action.orientation);
            break;
          case 'swipeRelativeToColorByOffset':
            record.observation = await swipeRelativeToVisibleColorByOffset(driver, action, rect);
            record.touches = record.observation.touches;
            break;
          case 'typeText':
            record.entry = await typeTextOnDevice(driver, action, scenario.device);
            break;
          case 'pressKey':
            record.entry = await pressEditorKey(driver, action, scenario.device);
            break;
          case 'tapNativeElement':
            record.entry = await tapNativeElement(driver, action, scenario.device);
            break;
          case 'hideKeyboard':
            record.entry = await hideDeviceKeyboard(driver, action, scenario.device);
            break;
          default:
            throw new Error(`Unsupported action type: ${action.type}`);
        }
        record.status = 'OK';
      } catch (error) {
        record.status = 'ERROR';
        record.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        record.completedAt = new Date().toISOString();
        saveManifest(manifestFile, manifest);
      }
    }
    manifest.status = 'COMPLETE';
  } catch (error) {
    if (driver) {
      try {
        manifest.failureScreenshot = await capture(
          driver,
          outputDir,
          screenshotSequence++,
          'failure-state',
          manifest,
        );
      } catch (captureError) {
        manifest.failureScreenshotError = captureError instanceof Error
          ? captureError.message
          : String(captureError);
      }
    }
    manifest.status = 'INFRA_ERROR';
    manifest.verdict = 'INFRA_ERROR';
    manifest.reason = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (driver) await driver.deleteSession().catch(() => {});
    try {
      await finishMobileVideo(video);
    } catch (recordingError) {
      manifest.recordingError = recordingError instanceof Error ? recordingError.message : String(recordingError);
      if (manifest.status === 'COMPLETE') {
        manifest.status = 'INFRA_ERROR';
        manifest.verdict = 'INFRA_ERROR';
        manifest.reason = manifest.recordingError;
      }
    }
    await stopProcess(appium, 'SIGTERM', 10000);
    if (existsSync(videoFile)) {
      manifest.video ??= { file: 'screen.mp4', startedAt: null, startsAfterCaseReady: false, touchOverlay: 'PENDING' };
      try {
        manifest.video.touchOverlay = renderTouchVideo(videoFile, touchVideoFile, touchIndicatorFile, manifest);
      } catch (touchError) {
        manifest.video.touchOverlay = { status: 'ERROR', reason: touchError instanceof Error ? touchError.message : String(touchError) };
      }
      if (manifest.status === 'COMPLETE' && manifest.video.touchOverlay?.status !== 'COMPLETE') {
        postRunError = new Error(`Mandatory touch-overlay video was not produced: ${manifest.video.touchOverlay?.reason ?? 'unknown error'}`);
        manifest.status = 'INFRA_ERROR';
        manifest.verdict = 'INFRA_ERROR';
        manifest.reason = postRunError.message;
      }
      if (existsSync(touchVideoFile)) {
        manifest.video.file = 'screen-touches.mp4';
        manifest.video.rawRecordingRetained = false;
        manifest.artifacts.push({ type: 'video', variant: 'touch-evidence', file: 'screen-touches.mp4', sha256: sha256(touchVideoFile) });
      }
      // Raw simulator video and the generated touch sprite are build inputs,
      // unless overlay generation failed and the raw file is needed to diagnose
      // the recorder. Successful runs retain only the annotated evidence video.
      if (existsSync(videoFile) && manifest.video.touchOverlay?.status === 'COMPLETE') unlinkSync(videoFile);
      else if (existsSync(videoFile)) {
        manifest.video.rawRecordingRetained = true;
        manifest.artifacts.push({ type: 'video', variant: 'raw-diagnostic', file: 'screen.mp4', sha256: sha256(videoFile) });
      }
      if (existsSync(touchIndicatorFile)) unlinkSync(touchIndicatorFile);
    }
    if (existsSync(appiumLog)) {
      sanitizeAppiumLog(appiumLog);
      manifest.artifacts.push({ type: 'log', file: 'appium.log', sha256: sha256(appiumLog) });
    }
    manifest.completedAt = new Date().toISOString();
    saveManifest(manifestFile, manifest);
    if (!quiet) console.log(manifestFile);
  }
  if (postRunError) throw postRunError;
  return manifestFile;
}

function describeLaunchTargets(loadedEnvironment, platform) {
  if (!loadedEnvironment) return null;
  const section = platform === 'Android' ? 'android' : 'ios';
  const fallback = platform === 'Android' ? 'chrome' : 'safari';
  const targets = resolveEnvironmentLaunchTargets(loadedEnvironment, platform);
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => {
    const bundle = target.apk ?? target.app ?? null;
    return [name, {
      application: target.package ?? target.bundleId ?? target.browserName ?? null,
      urlDelivery: target.urlDelivery,
      bundle: bundle ? { file: bundle, present: existsSync(bundle) } : null,
      default: name === (loadedEnvironment.value[section]?.defaultLaunchTarget ?? fallback),
    }];
  }));
}

function doctor(environmentFile) {
  const loadedEnvironment = loadEnvironment(environmentFile);
  const profiles = loadedEnvironment
    ? Object.values(loadedEnvironment.value.simulators ?? { default: loadedEnvironment.value.simulator }).filter(Boolean)
    : [];
  const platforms = new Set(profiles.map((profile) => platformName(profile.device)));
  if (!platforms.size) platforms.add('iOS');
  const checks = {
    node: process.version,
    xcrun: commandExists('xcrun'),
    adb: commandExists('adb'),
    swiftVision: commandExists('swift'),
    appiumBinary: existsSync(appiumBin),
    appiumHome: existsSync(appiumHome),
    xcuitestInstalled: false,
    environment: loadedEnvironment ? {
      name: loadedEnvironment.value.name,
      file: loadedEnvironment.file,
      simulatorProfiles: Object.keys(loadedEnvironment.value.simulators ?? { default: loadedEnvironment.value.simulator }).filter((name) => loadedEnvironment.value.simulators?.[name] || loadedEnvironment.value.simulator),
      health: checkEnvironment(loadedEnvironment),
    } : null,
  };
  if (checks.appiumBinary) {
    const list = spawnSync(appiumBin, ['driver', 'list', '--installed', '--json'], {
      cwd: root,
      env: { ...process.env, APPIUM_HOME: appiumHome },
      encoding: 'utf8',
    });
    checks.xcuitestInstalled = list.status === 0 && /"xcuitest"/.test(list.stdout);
  }
  if (platforms.has('iOS')) {
    const sims = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], { encoding: 'utf8' });
    checks.bootedSimulators = sims.status === 0 ? JSON.parse(sims.stdout).devices : {};
    checks.iosLaunchTargets = describeLaunchTargets(loadedEnvironment, 'iOS');
  }
  if (platforms.has('Android')) {
    const devices = spawnSync('adb', ['devices', '-l'], { encoding: 'utf8' });
    checks.androidDevices = devices.status === 0 ? devices.stdout.trim().split(/\r?\n/).slice(1).filter(Boolean) : [];
    checks.androidLaunchTargets = describeLaunchTargets(loadedEnvironment, 'Android');
  }
  console.log(JSON.stringify(checks, null, 2));
  const iosFailed = platforms.has('iOS') && (!checks.xcrun || !checks.swiftVision || !checks.xcuitestInstalled);
  const androidFailed = platforms.has('Android') && !checks.adb;
  const appiumFailed = platforms.has('iOS') && !checks.appiumBinary;
  if (iosFailed || androidFailed || appiumFailed
    || checks.environment?.health.some((check) => !check.ok)) process.exit(1);
}

function judge(runFile, status, reason) {
  if (!['PASS', 'FAIL', 'REVIEW'].includes(status)) die('--status must be PASS, FAIL, or REVIEW');
  const manifest = JSON.parse(readFileSync(runFile, 'utf8'));
  if (manifest.status !== 'COMPLETE') die(`Cannot judge run with status ${manifest.status}`);
  manifest.verdict = status;
  manifest.reason = reason || 'No reason supplied';
  const logArtifact = manifest.artifacts.find((artifact) => artifact.type === 'log');
  if (logArtifact) {
    const logFile = path.join(path.dirname(runFile), logArtifact.file);
    if (existsSync(logFile)) {
      sanitizeAppiumLog(logFile);
      logArtifact.sha256 = sha256(logFile);
    }
  }
  manifest.judgedAt = new Date().toISOString();
  saveManifest(runFile, manifest);
  console.log(runFile);
}

function screenshotArtifact(manifest, name) {
  const artifact = manifest.artifacts.find((item) => item.type === 'screenshot' && item.name === name);
  if (!artifact) throw new Error(`Run ${manifest.name} has no screenshot named ${name}`);
  return artifact;
}

function attachViewportVision(comparison, baselineFile, candidateFile, options) {
  if (!options.viewportVision) return comparison;
  const configuration = options.viewportVision === true ? {} : options.viewportVision;
  const baselineManifest = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const candidateManifest = JSON.parse(readFileSync(candidateFile, 'utf8'));
  const names = configuration.checkpoints ?? [comparison.from, comparison.to];
  if (!Array.isArray(names) || names.length === 0) throw new Error('viewportVision.checkpoints must be a non-empty array');
  const checkpoints = [...new Set(names)].map((name) => ({
    name,
    baselineFile: path.join(path.dirname(baselineFile), screenshotArtifact(baselineManifest, name).file),
    candidateFile: path.join(path.dirname(candidateFile), screenshotArtifact(candidateManifest, name).file),
  }));
  const analysis = analyzeViewportScreenshots(checkpoints, configuration);
  comparison.viewportVision = analysis;
  for (const checkpoint of analysis.checkpoints) {
    const scale = checkpoint.medianTextHeightScale;
    comparison.summaryMetrics.push({
      label: `Viewport text scale · ${checkpoint.name}`,
      value: scale === null ? `No match (${checkpoint.matchedTextCount})` : `${scale.toFixed(2)}× (${checkpoint.matchedTextCount})`,
    });
  }
  if (analysis.enforced && !analysis.passed) {
    comparison.interactionVerdict = { verdict: comparison.verdict, reason: comparison.reason };
    comparison.verdict = 'FAIL';
    const failures = analysis.checkpoints.filter((checkpoint) => !checkpoint.passed).map((checkpoint) => {
      const scale = checkpoint.medianTextHeightScale;
      return scale === null
        ? `${checkpoint.name} had ${checkpoint.matchedTextCount}/${checkpoint.minimumMatches} required visible text matches`
        : `${checkpoint.name} rendered matching text at ${scale.toFixed(2)}× Safari height`;
    });
    comparison.reason = `Viewport vision detected incompatible visible geometry: ${failures.join('; ')}`;
  }
  return comparison;
}

function visualSyncForScreenshot(manifest, name) {
  const screenshotIndex = manifest.actions.findIndex((action) => action.type === 'screenshot' && action.name === name);
  if (screenshotIndex < 0) return null;
  const screenshot = manifest.actions[screenshotIndex];
  if (!screenshot.syncWith) return null;
  for (let index = screenshotIndex - 1; index >= 0; index -= 1) {
    const action = manifest.actions[index];
    if (action.type === 'waitForColor' && action.name === screenshot.syncWith && action.status === 'OK' && action.observation) {
      return { marker: action.name, color: action.observation.color, observation: action.observation };
    }
  }
  return null;
}

function checkpointDifference(baselineFile, candidateFile, name, outputDir, pixelThreshold) {
  const baselineManifest = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const candidateManifest = JSON.parse(readFileSync(candidateFile, 'utf8'));
  if (baselineManifest.status !== 'COMPLETE' || candidateManifest.status !== 'COMPLETE') {
    throw new Error('Both runs must be COMPLETE');
  }
  const baselineArtifact = screenshotArtifact(baselineManifest, name);
  const candidateArtifact = screenshotArtifact(candidateManifest, name);
  const baselineImage = PNG.sync.read(readFileSync(path.join(path.dirname(baselineFile), baselineArtifact.file)));
  const candidateImage = PNG.sync.read(readFileSync(path.join(path.dirname(candidateFile), candidateArtifact.file)));
  if (baselineImage.width !== candidateImage.width || baselineImage.height !== candidateImage.height) {
    throw new Error(`Checkpoint ${name} has different baseline and candidate dimensions`);
  }
  const diff = new PNG({ width: baselineImage.width, height: baselineImage.height });
  const changedPixels = pixelmatch(
    baselineImage.data,
    candidateImage.data,
    diff.data,
    baselineImage.width,
    baselineImage.height,
    { threshold: pixelThreshold, includeAA: false },
  );
  const diffFile = path.join(outputDir, `${slug(name)}-baseline-candidate-diff.png`);
  writeFileSync(diffFile, PNG.sync.write(diff), { mode: 0o600 });
  return {
    name,
    width: baselineImage.width,
    height: baselineImage.height,
    changedPixels,
    changedPixelRatio: changedPixels / (baselineImage.width * baselineImage.height),
    baselineSync: visualSyncForScreenshot(baselineManifest, name),
    candidateSync: visualSyncForScreenshot(candidateManifest, name),
    diffFile: path.basename(diffFile),
  };
}

function withinRunTransition(runFile, side, fromName, toName, outputDir, pixelThreshold) {
  const manifest = JSON.parse(readFileSync(runFile, 'utf8'));
  if (manifest.status !== 'COMPLETE') throw new Error(`${side} run must be COMPLETE`);
  const fromArtifact = screenshotArtifact(manifest, fromName);
  const toArtifact = screenshotArtifact(manifest, toName);
  const fromImage = PNG.sync.read(readFileSync(path.join(path.dirname(runFile), fromArtifact.file)));
  const toImage = PNG.sync.read(readFileSync(path.join(path.dirname(runFile), toArtifact.file)));
  if (fromImage.width !== toImage.width || fromImage.height !== toImage.height) {
    throw new Error(`${side} transition checkpoints have different dimensions`);
  }
  const diff = new PNG({ width: fromImage.width, height: fromImage.height });
  const changedPixels = pixelmatch(
    fromImage.data,
    toImage.data,
    diff.data,
    fromImage.width,
    fromImage.height,
    { threshold: pixelThreshold, includeAA: false },
  );
  const diffFile = path.join(outputDir, `${slug(side)}-${slug(fromName)}-to-${slug(toName)}-diff.png`);
  writeFileSync(diffFile, PNG.sync.write(diff), { mode: 0o600 });
  return {
    side,
    from: fromName,
    to: toName,
    width: fromImage.width,
    height: fromImage.height,
    changedPixels,
    changedPixelRatio: changedPixels / (fromImage.width * fromImage.height),
    fromSync: visualSyncForScreenshot(manifest, fromName),
    toSync: visualSyncForScreenshot(manifest, toName),
    diffFile: path.basename(diffFile),
  };
}

function pinchIntegrityTransition(runFile, side, fromName, toName, outputDir, options, pixelThreshold) {
  const transition = withinRunTransition(runFile, side, fromName, toName, outputDir, pixelThreshold);
  const manifest = JSON.parse(readFileSync(runFile, 'utf8'));
  const fromArtifact = screenshotArtifact(manifest, fromName);
  const toArtifact = screenshotArtifact(manifest, toName);
  const fromImage = PNG.sync.read(readFileSync(path.join(path.dirname(runFile), fromArtifact.file)));
  const toImage = PNG.sync.read(readFileSync(path.join(path.dirname(runFile), toArtifact.file)));
  const tolerance = Number(options.zoomColorTolerance ?? 20);
  const before = colorGeometry(fromImage, options.zoomColor, tolerance);
  const after = colorGeometry(toImage, options.zoomColor, tolerance);
  if (!before || !after) throw new Error(`${side} pinch zoom marker ${options.zoomColor} is missing from a checkpoint`);
  const stableMarkers = (options.stableColors ?? []).map((color) => {
    const stableBefore = colorGeometry(fromImage, color, tolerance);
    const stableAfter = colorGeometry(toImage, color, tolerance);
    return {
      color: color.toLowerCase(),
      before: stableBefore,
      after: stableAfter,
      areaRatio: stableBefore && stableAfter ? stableAfter.pixels / stableBefore.pixels : null,
      centerMovementPixels: stableBefore && stableAfter
        ? Math.hypot(stableAfter.centerX - stableBefore.centerX, stableAfter.centerY - stableBefore.centerY)
        : null,
    };
  });
  return {
    ...transition,
    zoomColor: options.zoomColor.toLowerCase(),
    zoomGeometry: {
      before,
      after,
      areaRatio: after.pixels / before.pixels,
      widthRatio: after.width / before.width,
      heightRatio: after.height / before.height,
    },
    stableMarkers,
  };
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function reportImagePath(outputDir, file) {
  return encodeURI(path.relative(outputDir, file).split(path.sep).join('/'));
}

function writeComparisonReport(comparison, baselineFile, candidateFile, outputDir) {
  const baselineManifest = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const candidateManifest = JSON.parse(readFileSync(candidateFile, 'utf8'));
  const baselineLabel = `Direct ${baselineManifest.browser?.name ?? 'Safari'}`;
  const checkpoint = (runFile, manifest, name) => path.join(path.dirname(runFile), screenshotArtifact(manifest, name).file);
  const evidencePanels = [
    [baselineLabel, comparison.from, checkpoint(baselineFile, baselineManifest, comparison.from)],
    ['LiveView', comparison.from, checkpoint(candidateFile, candidateManifest, comparison.from)],
    [baselineLabel, comparison.to, checkpoint(baselineFile, baselineManifest, comparison.to)],
    ['LiveView', comparison.to, checkpoint(candidateFile, candidateManifest, comparison.to)],
  ];
  const diffPanels = ['relative-transition-diff', 'pinch-zoom-integrity'].includes(comparison.profile)
    ? [
      [`${baselineLabel} relative change`, `${comparison.from} → ${comparison.to}`, path.join(outputDir, comparison.transitions.baseline.diffFile)],
      ['LiveView relative change', `${comparison.from} → ${comparison.to}`, path.join(outputDir, comparison.transitions.candidate.diffFile)],
    ]
    : [
      ['Baseline vs LiveView diff', comparison.from, path.join(outputDir, comparison.checkpoints.from.diffFile)],
      ['Baseline vs LiveView diff', comparison.to, path.join(outputDir, comparison.checkpoints.to.diffFile)],
    ];
  const panels = [...evidencePanels, ...diffPanels];
  const metric = (label, value) => `<div class="metric"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong></div>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(comparison.verdict)} — LiveView mobile comparison</title>
<style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#172554;background:#eef2ff}body{margin:0;padding:28px}main{max-width:1440px;margin:auto}.summary,.panel,.metric{background:white;border:1px solid #c7d2fe;border-radius:14px;box-shadow:0 8px 25px #1e3a8a12}.summary{padding:22px;margin-bottom:18px}.verdict{display:inline-block;padding:7px 12px;border-radius:999px;font-weight:900;color:white;background:${comparison.verdict === 'PASS' ? '#15803d' : comparison.verdict === 'FAIL' ? '#b91c1c' : '#a16207'}}h1{margin:12px 0 6px;font-size:26px}.reason{font-size:17px;margin:0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.metric{padding:14px}.metric span{display:block;color:#475569;font-size:13px}.metric strong{display:block;margin-top:4px;font-size:20px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.panel{padding:12px}.panel h2{font-size:16px;margin:2px 0}.panel p{font-size:13px;color:#64748b;margin:3px 0 10px}.panel img{display:block;width:100%;max-height:760px;object-fit:contain;background:#111827;border-radius:8px}footer{margin-top:20px;color:#64748b;font-size:13px}a{color:#1d4ed8}@media(max-width:760px){body{padding:12px}.grid{grid-template-columns:1fr}}
</style></head><body><main>
<section class="summary"><span class="verdict">${htmlEscape(comparison.verdict)}</span><h1>LiveView mobile comparison</h1><p class="reason">${htmlEscape(comparison.reason)}</p></section>
<section class="metrics">
${comparison.summaryMetrics.map((item) => metric(item.label, item.value)).join('')}
</section>
<section class="grid">${panels.map(([title, subtitle, file]) => `<article class="panel"><h2>${htmlEscape(title)}</h2><p>${htmlEscape(subtitle)}</p><a href="${htmlEscape(reportImagePath(outputDir, file))}"><img loading="lazy" src="${htmlEscape(reportImagePath(outputDir, file))}" alt="${htmlEscape(`${title} ${subtitle}`)}"></a></article>`).join('')}</section>
<footer>Pixel-only evidence. No remote DOM, CDP, or web selectors. <a href="comparison.json">Open comparison.json</a></footer>
</main></body></html>`;
  const reportFile = path.join(outputDir, 'report.html');
  writeFileSync(reportFile, html, { mode: 0o600 });
  return reportFile;
}

function compareRuns(baselineFile, candidateFile, fromName, toName, outputOverride, options = {}, quiet = false) {
  const outputDir = path.resolve(outputOverride || path.join(root, 'artifacts', 'comparison'));
  const baselineBrowser = JSON.parse(readFileSync(baselineFile, 'utf8')).browser?.name ?? 'Safari';
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const profile = options.profile ?? 'checkpoint-pixel-diff';
  if (!['checkpoint-pixel-diff', 'relative-transition-diff', 'pinch-zoom-integrity'].includes(profile)) throw new Error(`Unknown comparison profile ${profile}`);
  const pixelThreshold = Number(options.pixelThreshold ?? 0.15);
  if (!Number.isFinite(pixelThreshold) || pixelThreshold < 0 || pixelThreshold > 1) throw new Error('pixelThreshold must be between 0 and 1');
  if (profile === 'pinch-zoom-integrity') {
    if (!options.zoomColor) throw new Error('pinch-zoom-integrity requires zoomColor');
    if (!Array.isArray(options.stableColors) || options.stableColors.length < 2) {
      throw new Error('pinch-zoom-integrity requires at least two stableColors outside the zoom area');
    }
    const minZoomAreaRatio = Number(options.minZoomAreaRatio ?? 1.5);
    const maxZoomAreaRatioDelta = Number(options.maxZoomAreaRatioDelta ?? 0.15);
    const maxStableMarkerAreaRatioDelta = Number(options.maxStableMarkerAreaRatioDelta ?? 0.12);
    const maxStableMarkerMovementPixels = Number(options.maxStableMarkerMovementPixels ?? 15);
    if (!Number.isFinite(minZoomAreaRatio) || minZoomAreaRatio <= 1) throw new Error('minZoomAreaRatio must be greater than 1');
    if (!Number.isFinite(maxZoomAreaRatioDelta) || maxZoomAreaRatioDelta < 0) {
      throw new Error('maxZoomAreaRatioDelta must be zero or greater');
    }
    if (!Number.isFinite(maxStableMarkerAreaRatioDelta) || maxStableMarkerAreaRatioDelta < 0) {
      throw new Error('maxStableMarkerAreaRatioDelta must be zero or greater');
    }
    if (!Number.isFinite(maxStableMarkerMovementPixels) || maxStableMarkerMovementPixels < 0) {
      throw new Error('maxStableMarkerMovementPixels must be zero or greater');
    }
    const baseline = pinchIntegrityTransition(baselineFile, 'baseline', fromName, toName, outputDir, options, pixelThreshold);
    const candidate = pinchIntegrityTransition(candidateFile, 'candidate', fromName, toName, outputDir, options, pixelThreshold);
    const markerAligned = (phase) => Boolean(
      baseline[`${phase}Sync`]?.marker
      && baseline[`${phase}Sync`].marker === candidate[`${phase}Sync`]?.marker
      && baseline[`${phase}Sync`].color === candidate[`${phase}Sync`].color,
    );
    const timelineSync = { from: markerAligned('from'), to: markerAligned('to') };
    timelineSync.aligned = Boolean(timelineSync.from && timelineSync.to);
    const zoomPassed = baseline.zoomGeometry.areaRatio >= minZoomAreaRatio
      && candidate.zoomGeometry.areaRatio >= minZoomAreaRatio;
    const zoomAreaRatioDelta = Math.abs(baseline.zoomGeometry.areaRatio - candidate.zoomGeometry.areaRatio);
    const relativeZoomPassed = zoomAreaRatioDelta <= maxZoomAreaRatioDelta;
    const stableMarkerPassed = (marker) => marker.before && marker.after
      && Math.abs(marker.areaRatio - 1) <= maxStableMarkerAreaRatioDelta
      && marker.centerMovementPixels <= maxStableMarkerMovementPixels;
    const baselineIsolationPassed = baseline.stableMarkers.every(stableMarkerPassed);
    const candidateIsolationPassed = candidate.stableMarkers.every(stableMarkerPassed);
    const isolationPassed = baselineIsolationPassed && candidateIsolationPassed;
    const verdict = timelineSync.aligned && zoomPassed && relativeZoomPassed && isolationPassed ? 'PASS' : 'FAIL';
    const failures = [];
    if (!timelineSync.aligned) failures.push('visible checkpoints were not synchronized');
    if (!zoomPassed) failures.push(`zoom target did not grow by at least ${minZoomAreaRatio.toFixed(2)}× on both sides`);
    if (!relativeZoomPassed) failures.push(`${baselineBrowser} and LiveView zoom ratios differed by more than ${maxZoomAreaRatioDelta.toFixed(2)}`);
    if (!isolationPassed) failures.push('one or more markers outside the bounded pinch area moved, scaled, or disappeared');
    const reason = failures.length
      ? `Pinch integrity failed: ${failures.join('; ')}`
      : `Pinch stayed inside the bounded area, produced equivalent relative magnification, and preserved tap mapping`;
    const summaryMetrics = [
      { label: 'Timeline synchronized', value: timelineSync.aligned ? 'Yes' : 'No' },
      { label: `${baselineBrowser} target area`, value: `${baseline.zoomGeometry.areaRatio.toFixed(2)}×` },
      { label: 'LiveView target area', value: `${candidate.zoomGeometry.areaRatio.toFixed(2)}×` },
      { label: 'Cross-side zoom delta', value: zoomAreaRatioDelta.toFixed(3) },
      { label: `${baselineBrowser} outer markers`, value: baselineIsolationPassed ? 'Stable' : 'Changed' },
      { label: 'LiveView outer markers', value: candidateIsolationPassed ? 'Stable' : 'Changed' },
    ];
    const comparison = {
      schemaVersion: 1,
      status: 'COMPLETE',
      verdict,
      reason,
      comparedAt: new Date().toISOString(),
      profile,
      from: fromName,
      to: toName,
      pixelThreshold,
      zoomColor: options.zoomColor.toLowerCase(),
      minZoomAreaRatio,
      maxZoomAreaRatioDelta,
      zoomAreaRatioDelta,
      stableColors: options.stableColors.map((color) => color.toLowerCase()),
      maxStableMarkerAreaRatioDelta,
      maxStableMarkerMovementPixels,
      isolation: {
        baselinePassed: baselineIsolationPassed,
        candidatePassed: candidateIsolationPassed,
        passed: isolationPassed,
      },
      timelineSync,
      transitions: { baseline, candidate },
      summaryMetrics,
      artifacts: [baseline.diffFile, candidate.diffFile].map((file) => ({ file, sha256: sha256(path.join(outputDir, file)) })),
    };
    attachViewportVision(comparison, baselineFile, candidateFile, options);
    const comparisonFile = path.join(outputDir, 'comparison.json');
    const reportFile = writeComparisonReport(comparison, baselineFile, candidateFile, outputDir);
    comparison.artifacts.push({ file: path.basename(reportFile), sha256: sha256(reportFile) });
    saveManifest(comparisonFile, comparison);
    if (!quiet) console.log(comparisonFile);
    return comparisonFile;
  }
  if (profile === 'relative-transition-diff') {
    const configuredLimit = options.maxTransitionRatioDelta === null || options.maxTransitionRatioDelta === undefined
      ? null
      : Number(options.maxTransitionRatioDelta);
    if (configuredLimit !== null && (!Number.isFinite(configuredLimit) || configuredLimit < 0 || configuredLimit > 1)) {
      throw new Error('maxTransitionRatioDelta must be null or between 0 and 1');
    }
    const baseline = withinRunTransition(baselineFile, 'baseline', fromName, toName, outputDir, pixelThreshold);
    const candidate = withinRunTransition(candidateFile, 'candidate', fromName, toName, outputDir, pixelThreshold);
    const markerAligned = (phase) => Boolean(
      baseline[`${phase}Sync`]?.marker
      && baseline[`${phase}Sync`].marker === candidate[`${phase}Sync`]?.marker
      && baseline[`${phase}Sync`].color === candidate[`${phase}Sync`].color,
    );
    const timelineSync = { from: markerAligned('from'), to: markerAligned('to') };
    timelineSync.aligned = Boolean(timelineSync.from && timelineSync.to);
    const transitionRatioDelta = Math.abs(baseline.changedPixelRatio - candidate.changedPixelRatio);
    const verdict = !timelineSync.aligned || configuredLimit === null
      ? 'REVIEW'
      : transitionRatioDelta > configuredLimit ? 'FAIL' : 'PASS';
    const reason = !timelineSync.aligned
      ? 'Relative transition checkpoints are not aligned by matching visible phase markers'
      : configuredLimit === null
        ? 'Relative transition evidence generated; no automatic transition-delta threshold was configured'
        : transitionRatioDelta > configuredLimit
          ? `Relative transition delta ${(transitionRatioDelta * 100).toFixed(2)}% exceeded the configured ${(configuredLimit * 100).toFixed(2)}% limit`
          : `Relative transition delta ${(transitionRatioDelta * 100).toFixed(2)}% stayed within the configured ${(configuredLimit * 100).toFixed(2)}% limit`;
    const summaryMetrics = [
      { label: 'Timeline synchronized', value: timelineSync.aligned ? 'Yes' : 'No' },
      { label: `${baselineBrowser} relative change`, value: `${(baseline.changedPixelRatio * 100).toFixed(2)}%` },
      { label: 'LiveView relative change', value: `${(candidate.changedPixelRatio * 100).toFixed(2)}%` },
      { label: 'Transition ratio delta', value: `${(transitionRatioDelta * 100).toFixed(2)}%` },
    ];
    const comparison = {
      schemaVersion: 1,
      status: 'COMPLETE',
      verdict,
      reason,
      comparedAt: new Date().toISOString(),
      profile,
      from: fromName,
      to: toName,
      pixelThreshold,
      maxTransitionRatioDelta: configuredLimit,
      timelineSync,
      transitions: { baseline, candidate },
      transitionRatioDelta,
      summaryMetrics,
      artifacts: [baseline.diffFile, candidate.diffFile].map((file) => ({ file, sha256: sha256(path.join(outputDir, file)) })),
    };
    attachViewportVision(comparison, baselineFile, candidateFile, options);
    const comparisonFile = path.join(outputDir, 'comparison.json');
    const reportFile = writeComparisonReport(comparison, baselineFile, candidateFile, outputDir);
    comparison.artifacts.push({ file: path.basename(reportFile), sha256: sha256(reportFile) });
    saveManifest(comparisonFile, comparison);
    if (!quiet) console.log(comparisonFile);
    return comparisonFile;
  }
  const maxChangedPixelRatio = options.maxChangedPixelRatio === null || options.maxChangedPixelRatio === undefined
    ? null
    : Number(options.maxChangedPixelRatio);
  if (maxChangedPixelRatio !== null && (!Number.isFinite(maxChangedPixelRatio) || maxChangedPixelRatio < 0 || maxChangedPixelRatio > 1)) {
    throw new Error('maxChangedPixelRatio must be null or between 0 and 1');
  }
  const from = checkpointDifference(baselineFile, candidateFile, fromName, outputDir, pixelThreshold);
  const to = checkpointDifference(baselineFile, candidateFile, toName, outputDir, pixelThreshold);
  const markerAligned = (checkpoint) => Boolean(
    checkpoint.baselineSync?.marker
    && checkpoint.baselineSync.marker === checkpoint.candidateSync?.marker
    && checkpoint.baselineSync.color === checkpoint.candidateSync.color,
  );
  const timelineSync = {
    from: markerAligned(from),
    to: markerAligned(to),
  };
  timelineSync.aligned = Boolean(timelineSync.from && timelineSync.to);
  const maximumChangedPixelRatio = Math.max(from.changedPixelRatio, to.changedPixelRatio);
  const verdict = !timelineSync.aligned || maxChangedPixelRatio === null
    ? 'REVIEW'
    : maximumChangedPixelRatio > maxChangedPixelRatio ? 'FAIL' : 'PASS';
  const reason = !timelineSync.aligned
    ? 'Comparison checkpoints are not aligned by matching visible phase markers'
    : maxChangedPixelRatio === null
      ? 'Synchronized evidence generated; no automatic acceptance threshold was configured'
      : maximumChangedPixelRatio > maxChangedPixelRatio
        ? `Baseline-to-LiveView difference ${(maximumChangedPixelRatio * 100).toFixed(2)}% exceeded the configured ${(maxChangedPixelRatio * 100).toFixed(2)}% limit`
        : `Baseline-to-LiveView difference ${(maximumChangedPixelRatio * 100).toFixed(2)}% stayed within the configured ${(maxChangedPixelRatio * 100).toFixed(2)}% limit`;
  const summaryMetrics = [
    { label: 'Timeline synchronized', value: timelineSync.aligned ? 'Yes' : 'No' },
    { label: `${fromName} difference`, value: `${(from.changedPixelRatio * 100).toFixed(2)}%` },
    { label: `${toName} difference`, value: `${(to.changedPixelRatio * 100).toFixed(2)}%` },
  ];
  const comparison = {
    schemaVersion: 1,
    status: 'COMPLETE',
    verdict,
    reason,
    comparedAt: new Date().toISOString(),
    profile,
    from: fromName,
    to: toName,
    pixelThreshold,
    maxChangedPixelRatio,
    timelineSync,
    checkpoints: { from, to },
    maximumChangedPixelRatio,
    summaryMetrics,
    artifacts: [from.diffFile, to.diffFile].map((file) => ({ file, sha256: sha256(path.join(outputDir, file)) })),
  };
  attachViewportVision(comparison, baselineFile, candidateFile, options);
  const comparisonFile = path.join(outputDir, 'comparison.json');
  const reportFile = writeComparisonReport(comparison, baselineFile, candidateFile, outputDir);
  comparison.artifacts.push({ file: path.basename(reportFile), sha256: sha256(reportFile) });
  saveManifest(comparisonFile, comparison);
  if (!quiet) console.log(comparisonFile);
  return comparisonFile;
}

function sharedSyncedCheckpoints(baselineManifest, candidateManifest) {
  const synced = (manifest) => (manifest.actions ?? [])
    .filter((action) => action.type === 'screenshot' && action.status === 'OK' && action.name && action.syncWith)
    .map((action) => ({ name: action.name, marker: action.syncWith }));
  const candidate = new Map(synced(candidateManifest).map((item) => [item.name, item.marker]));
  return synced(baselineManifest).filter((item) => candidate.get(item.name) === item.marker);
}

function reportPairDirectory(baselineFile, candidateFile) {
  const baselineParent = path.dirname(path.dirname(baselineFile));
  const candidateParent = path.dirname(path.dirname(candidateFile));
  if (baselineParent !== candidateParent) {
    throw new Error('report requires baseline and candidate run.json files under the same pair directory');
  }
  const artifactsRoot = path.join(root, 'artifacts');
  const relative = path.relative(artifactsRoot, baselineParent);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('report run.json files must belong to a pair directory under artifacts/');
  }
  return baselineParent;
}

function reportFromRuns(baselineFile, candidateFile, fromOverride, toOverride, outputOverride, comparisonOptions) {
  const baselineManifest = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const candidateManifest = JSON.parse(readFileSync(candidateFile, 'utf8'));
  if (baselineManifest.status !== 'COMPLETE' || candidateManifest.status !== 'COMPLETE') {
    throw new Error('report requires two COMPLETE run manifests');
  }
  const checkpoints = sharedSyncedCheckpoints(baselineManifest, candidateManifest);
  if (checkpoints.length < 2 && (!fromOverride || !toOverride)) {
    throw new Error('report could not infer two shared marker-synchronized screenshots; pass --from and --to');
  }
  const fromName = fromOverride ?? checkpoints[0].name;
  const toName = toOverride ?? checkpoints.at(-1).name;
  if (fromName === toName) throw new Error('report comparison requires different --from and --to screenshots');

  const pairDir = reportPairDirectory(baselineFile, candidateFile);
  const comparisonDir = path.resolve(outputOverride || path.join(pairDir, 'comparison'));
  const comparisonFile = compareRuns(
    baselineFile,
    candidateFile,
    fromName,
    toName,
    comparisonDir,
    comparisonOptions,
    true,
  );
  const comparison = JSON.parse(readFileSync(comparisonFile, 'utf8'));
  const pairFile = path.join(pairDir, 'pair.json');
  const existing = existsSync(pairFile) ? JSON.parse(readFileSync(pairFile, 'utf8')) : {};
  const baseName = String(baselineManifest.name ?? 'baseline').replace(/-baseline$/, '');
  const pair = {
    schemaVersion: 1,
    ...existing,
    name: existing.name ?? baseName,
    testDescription: existing.testDescription ?? baselineManifest.testDescription ?? candidateManifest.testDescription ?? null,
    testPage: existing.testPage ?? baselineManifest.testPage ?? candidateManifest.testPage ?? null,
    startedAt: existing.startedAt ?? baselineManifest.startedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'COMPLETE',
    verdict: comparison.verdict,
    reason: comparison.reason,
    baseline: path.relative(pairDir, baselineFile),
    candidate: path.relative(pairDir, candidateFile),
    comparison: path.relative(pairDir, comparisonFile),
    report: path.relative(pairDir, path.join(comparisonDir, 'report.html')),
  };
  saveManifest(pairFile, pair);

  const dashboardScript = path.join(root, 'src', 'dashboard.mjs');
  const dashboardFile = path.join(root, 'artifacts', 'index.html');
  const generated = spawnSync(process.execPath, [
    dashboardScript,
    '--manifest', pairFile,
    '--output', dashboardFile,
  ], { encoding: 'utf8' });
  if (generated.status !== 0) {
    throw new Error(`dashboard generation failed: ${(generated.stderr || generated.stdout).trim()}`);
  }
  console.log(dashboardFile);
  return pairFile;
}

function runRemoteScript(sshTarget, script) {
  const command = sshTarget === 'local' ? ['bash', ['-s']] : ['ssh', [sshTarget, 'bash', '-s']];
  const result = spawnSync(command[0], command[1], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Session command failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
}

function provisionPairSession(provider, pairName, encryption) {
  if (!provider?.ssh || !provider?.adminToken) throw new Error('sessionProvider requires ssh and adminToken');
  const controlPlaneUrl = provider.controlPlaneUrl ?? 'http://127.0.0.1:8081';
  const cluster = provider.cluster ?? 'local';
  const sessionId = `${slug(pairName)}-${Date.now()}`;
  const clientBody = JSON.stringify({ name: `mobile pair ${pairName}`, allowedClusters: [cluster] });
  // liveViewEncryption is what makes the control plane mint an enrolled viewer URL
  // (?encryption=e2e plus the #popcorn-e2e bootstrap). Asking for it here and
  // reading it back in liveviewHostUrl is one decision made in two places, so the
  // URL builder fails loudly if they ever disagree.
  const sessionBody = JSON.stringify({
    sessionId,
    regions: [provider.region ?? cluster],
    ...(readEncryption(encryption) ? { liveViewEncryption: readEncryption(encryption) } : {}),
  });
  const script = `set -eu
control_plane=${shellQuote(controlPlaneUrl)}
admin_token=${shellQuote(provider.adminToken)}
client_json=$(curl -fsS -X POST "$control_plane/admin/clients" -H "Authorization: Bearer $admin_token" -H 'Content-Type: application/json' -d ${shellQuote(clientBody)})
client_id=$(printf '%s' "$client_json" | jq -r .clientId)
client_secret=$(printf '%s' "$client_json" | jq -r .clientSecret)
session_json=$(curl -fsS -X POST "$control_plane/v1/sessions" -H "Authorization: Bearer $client_id:$client_secret" -H 'Content-Type: application/json' -d ${shellQuote(sessionBody)})
jq -cn --arg clientId "$client_id" --arg clientSecret "$client_secret" --argjson session "$session_json" '{clientId:$clientId,clientSecret:$clientSecret,session:$session}'
`;
  const handle = JSON.parse(runRemoteScript(provider.ssh, script));
  if (!handle.session?.success || !handle.session?.vncUrl) throw new Error('Remote session allocation did not return a successful vncUrl');
  return handle;
}

function cleanupPairSession(provider, handle) {
  const controlPlaneUrl = provider.controlPlaneUrl ?? 'http://127.0.0.1:8081';
  const script = `set -eu
control_plane=${shellQuote(controlPlaneUrl)}
admin_token=${shellQuote(provider.adminToken)}
client_id=${shellQuote(handle.clientId)}
client_secret=${shellQuote(handle.clientSecret)}
session_id=${shellQuote(handle.session.sessionId)}
session_code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$control_plane/v1/session/$session_id" -H "Authorization: Bearer $client_id:$client_secret")
client_code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$control_plane/admin/clients/$client_id" -H "Authorization: Bearer $admin_token")
printf '%s %s' "$session_code" "$client_code"
`;
  const [sessionCode, clientCode] = runRemoteScript(provider.ssh, script).split(/\s+/);
  if (sessionCode !== '200' || clientCode !== '200') throw new Error(`Remote session cleanup returned session=${sessionCode}, client=${clientCode}`);
  return { sessionDeleteStatus: Number(sessionCode), clientDeleteStatus: Number(clientCode) };
}

function cdpCommand(socket, id, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`CDP ${method} timed out`));
    }, 10000);
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(`CDP ${method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
      else resolve(message.result ?? {});
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

// Poll the page target's URL until it is the one we asked for. Compares pathname
// only: a fixture may carry a cache-buster or pick up a hash, and neither means the
// kiosk is on the wrong page.
async function navigationLanded(socket, targetUrl, timeoutMs = 8000) {
  const wanted = new URL(targetUrl).pathname;
  const deadline = Date.now() + timeoutMs;
  let url = null;
  for (let id = 100; Date.now() < deadline; id += 1) {
    const targets = await cdpCommand(socket, id, 'Target.getTargets');
    const page = targets.targetInfos?.find((item) => item.type === 'page');
    url = page?.url ?? null;
    if (url) {
      try {
        if (new URL(url).pathname === wanted) return { ok: true, url };
      } catch { /* about:blank and friends are simply not there yet */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, url };
}

async function navigateSession(session, gatewayOrigin, targetUrl) {
  const rawEndpoint = session.cdpInternalUrl ?? session.cdpUrl;
  if (!rawEndpoint) throw new Error('Session response has no CDP endpoint for startup navigation');
  const endpoint = new URL(rawEndpoint);
  const gateway = new URL(gatewayOrigin);
  endpoint.protocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.host = gateway.host;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const socket = new WebSocket(endpoint);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('CDP startup navigation connection timed out')), 10000);
        socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP startup navigation connection failed')); }, { once: true });
      });
      const targets = await cdpCommand(socket, 1, 'Target.getTargets');
      const target = targets.targetInfos?.find((item) => item.type === 'page');
      if (!target) throw new Error('CDP startup navigation found no page target');
      const attached = await cdpCommand(socket, 2, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await cdpCommand(socket, 3, 'Page.navigate', { url: targetUrl }, attached.sessionId);
      // Page.navigate's acknowledgement says the command was accepted, not that the
      // kiosk left the previous case's page. A navigation that never lands leaves the
      // PRIOR fixture on screen, and fixtures share their ready marker — so the stale
      // page satisfies the ready gate and the run continues until some later action
      // fails, which candidateActionFailureVerdict then grades FAIL. That is an infra
      // failure wearing a product verdict, so settle it here where it is still infra.
      // Target metadata only, in keeping with this step never reading page state.
      const landed = await navigationLanded(socket, targetUrl);
      if (!landed.ok) throw new Error(`CDP startup navigation did not land: kiosk is on ${redactUrl(landed.url ?? 'an unknown page')}`);
      return {
        method: 'cdp-page-navigate',
        targetUrl: redactUrl(targetUrl),
        acknowledged: true,
        landed: true,
        attempts: attempt,
        verification: 'cdp-target-url-then-simulator-recording-start-marker',
      };
    } catch (error) {
      // Some navigation targets replace the attached page before the flattened
      // session can return Page.navigate's acknowledgement. Reattach and
      // dispatch the idempotent startup URL again before relying on the
      // framebuffer-visible recordingStart marker.
      if (error?.message !== 'CDP Page.navigate timed out') throw error;
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      socket.close();
    }
  }
  return {
    method: 'cdp-page-navigate',
    targetUrl: redactUrl(targetUrl),
    acknowledged: false,
    attempts: maxAttempts,
    verification: 'simulator-recording-start-marker',
  };
}

function pairScenario(pair, targetName, pairFile, sessionFileOverride) {
  const target = pair[targetName];
  if (!target || typeof target !== 'object') throw new Error(`Pair requires ${targetName} target`);
  if (!Array.isArray(pair.actions) || pair.actions.length === 0) throw new Error('Pair requires a shared non-empty actions array');
  const liveview = target.liveview ? { ...target.liveview } : undefined;
  if (liveview && sessionFileOverride) liveview.sessionFile = sessionFileOverride;
  else if (liveview?.sessionFile) liveview.sessionFile = path.resolve(path.dirname(pairFile), liveview.sessionFile);
  return {
    name: `${pair.name}-${targetName}`,
    device: pair.device,
    settleMs: target.settleMs ?? pair.settleMs,
    nativeOpenUrl: target.nativeOpenUrl ?? pair.nativeOpenUrl ?? true,
    appiumPort: pair.appiumPort,
    wdaLocalPort: pair.wdaLocalPort,
    mjpegServerPort: pair.mjpegServerPort,
    derivedDataPath: pair.derivedDataPath,
    caseId: pair.caseId,
    testDescription: pair.testDescription,
    testPage: pair.testPage,
    setupActions: target.setupActions ?? pair.setupActions ?? [],
    ...(target.launchTarget ? { launchTarget: target.launchTarget } : {}),
    recordingStart: target.recordingStart ?? pair.recordingStart,
    recordingLeadInMs: target.recordingLeadInMs ?? pair.recordingLeadInMs,
    actions: actionsForTarget(pair.actions, targetName, platformName(pair.device), pair.actionCoordinateScale),
    ...(target.url ? { url: target.url } : {}),
    ...(liveview ? { liveview } : {}),
  };
}

function validatePairCheckpoints(pair) {
  const { from, to } = pair.compare ?? {};
  if (!from || !to) throw new Error('Pair compare requires from and to screenshot names');
  for (const name of [from, to]) {
    const screenshotIndex = pair.actions.findIndex((action) => action.type === 'screenshot' && action.name === name);
    if (screenshotIndex < 0) throw new Error(`Pair compare checkpoint ${name} is not a screenshot action`);
    const screenshot = pair.actions[screenshotIndex];
    if (!screenshot.syncWith) throw new Error(`Pair compare checkpoint ${name} requires syncWith`);
    const marker = pair.actions.slice(0, screenshotIndex).findLast((action) => action.type === 'waitForColor' && action.name === screenshot.syncWith);
    if (!marker) throw new Error(`Pair checkpoint ${name} has no preceding waitForColor named ${screenshot.syncWith}`);
  }
}

async function runPair(pairFile, outputOverride, environmentFile, simulatorName) {
  const loadedEnvironment = loadEnvironment(environmentFile);
  const environmentHealth = checkEnvironment(loadedEnvironment);
  const failedHealth = environmentHealth.filter((check) => !check.ok);
  if (failedHealth.length) {
    throw new Error(`Environment preflight failed: ${failedHealth.map((check) => `${check.name}: ${check.error ?? `HTTP ${check.statusCode}`}`).join('; ')}`);
  }
  await refuseBusyRuntime(loadedEnvironment);
  const pair = materializePair(
    JSON.parse(readFileSync(pairFile, 'utf8')),
    pairFile,
    loadedEnvironment,
    simulatorName,
  );
  if (pair.baseline?.fixturePath && pair.baseline?.url) {
    const fixtureUrl = new URL(pair.baseline.url);
    fixtureUrl.searchParams.set('_harnessRun', Date.now().toString(36));
    pair.baseline.url = fixtureUrl.toString();
  }
  if (!pair.name || !pair.device?.udid) throw new Error('Pair requires name and device.udid');
  if (!Array.isArray(pair.actions) || pair.actions.length === 0) throw new Error('Pair requires a shared non-empty actions array');
  validatePairCheckpoints(pair);
  const pairPlatform = platformName(pair.device);
  const defaultOutputName = pairPlatform === 'Android'
    ? `${slug(pair.name)}-android`
    : slug(pair.name);
  const finalOutputDir = path.resolve(outputOverride || path.join(root, 'artifacts', defaultOutputName));
  const staleStaging = removeStaleStagingDirectories(finalOutputDir);
  const outputDir = stagingDirectory(finalOutputDir);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  let pairManifestFile = path.join(outputDir, 'pair.json');
  const pairManifest = {
    schemaVersion: 1,
    name: pair.name,
    caseId: pair.caseId ?? null,
    testDescription: pair.testDescription ?? null,
    testPage: pair.testPage ?? null,
    platform: pairPlatform,
    browser: browserName(pair.device, pair.baseline?.launchTarget),
    launchTargets: {
      baseline: pair.baseline?.launchTarget?.name ?? null,
      candidate: pair.candidate?.launchTarget?.name ?? null,
    },
    device: pair.device,
    environment: pair.environment ?? null,
    environmentHealth,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'RUNNING',
    verdict: 'REVIEW',
    reason: 'Pair is running',
    baseline: null,
    candidate: null,
    comparison: null,
    report: null,
    session: null,
  };
  saveManifest(pairManifestFile, pairManifest);
  const baselineScenarioFile = path.join(outputDir, 'baseline-scenario.json');
  const candidateScenarioFile = path.join(outputDir, 'candidate-scenario.json');
  saveManifest(baselineScenarioFile, pairScenario(pair, 'baseline', pairFile));
  let sessionHandle;
  let localSessionFile;
  try {
    const baselineRun = await runScenario(baselineScenarioFile, path.join(outputDir, 'baseline'), true);
    pairManifest.baseline = path.relative(outputDir, baselineRun);
    saveManifest(pairManifestFile, pairManifest);
    if (pair.sessionProvider) {
      sessionHandle = provisionPairSession(pair.sessionProvider, pair.name, pair.candidate?.liveview?.encryption);
      localSessionFile = path.join(outputDir, '.liveview-session.json');
      saveManifest(localSessionFile, sessionHandle.session);
      pairManifest.session = {
        sessionId: sessionHandle.session.sessionId,
        provider: `ssh:${pair.sessionProvider.ssh}`,
        cleanup: 'PENDING',
      };
      saveManifest(pairManifestFile, pairManifest);
    }
    if (pair.navigation?.method === 'cdp-page-navigate') {
      if (!sessionHandle) throw new Error('CDP startup navigation requires a provisioned session');
      const targetUrl = pair.navigation.source === 'baseline'
        ? pair.baseline.url
        : pair.navigation.targetUrl;
      if (!targetUrl) throw new Error('CDP startup navigation requires a target URL');
      pairManifest.session.navigation = await navigateSession(
        sessionHandle.session,
        pair.candidate.liveview.gatewayOrigin,
        targetUrl,
      );
      saveManifest(pairManifestFile, pairManifest);
    }
    saveManifest(candidateScenarioFile, pairScenario(pair, 'candidate', pairFile, localSessionFile));
    const candidateRun = await runScenario(candidateScenarioFile, path.join(outputDir, 'candidate'), true);
    pairManifest.candidate = path.relative(outputDir, candidateRun);
    saveManifest(pairManifestFile, pairManifest);
    const comparisonFile = compareRuns(
      baselineRun,
      candidateRun,
      pair.compare.from,
      pair.compare.to,
      path.join(outputDir, 'comparison'),
      pair.compare,
      true,
    );
    const comparison = JSON.parse(readFileSync(comparisonFile, 'utf8'));
    pairManifest.comparison = path.relative(outputDir, comparisonFile);
    pairManifest.report = path.relative(outputDir, path.join(path.dirname(comparisonFile), 'report.html'));
    pairManifest.status = 'COMPLETE';
    pairManifest.verdict = comparison.verdict;
    pairManifest.reason = comparison.reason;
  } catch (error) {
    const candidateRunFile = path.join(outputDir, 'candidate', 'run.json');
    let candidateManifest = null;
    if (existsSync(candidateRunFile)) {
      try {
        candidateManifest = JSON.parse(readFileSync(candidateRunFile, 'utf8'));
      } catch {
        candidateManifest = null;
      }
    }
    const failedAction = candidateManifest?.actions?.find((action) => action.status === 'ERROR');
    const visibleCandidateFailure = pair.candidateActionFailureVerdict === 'FAIL'
      && Boolean(pairManifest.baseline)
      && candidateManifest?.recordingStart?.status === 'OK'
      && Boolean(failedAction);
    if (visibleCandidateFailure) {
      pairManifest.candidate = path.relative(outputDir, candidateRunFile);
      pairManifest.status = 'COMPLETE';
      pairManifest.verdict = 'FAIL';
      pairManifest.reason = `LiveView failed visible action ${failedAction.name ?? failedAction.type}: ${failedAction.error ?? (error instanceof Error ? error.message : String(error))}`;
      pairManifest.productFailure = {
        action: failedAction.name ?? failedAction.type,
        error: failedAction.error ?? (error instanceof Error ? error.message : String(error)),
        baselineCompleted: true,
        candidateRecordingReady: true,
      };
    } else {
      pairManifest.status = 'INFRA_ERROR';
      pairManifest.verdict = 'INFRA_ERROR';
      pairManifest.reason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  } finally {
    if (sessionHandle) {
      try {
        pairManifest.session.cleanup = cleanupPairSession(pair.sessionProvider, sessionHandle);
      } catch (cleanupError) {
        pairManifest.session.cleanup = { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) };
      }
    }
    if (localSessionFile && existsSync(localSessionFile)) unlinkSync(localSessionFile);
    pairManifest.completedAt = new Date().toISOString();
    const replacedPrevious = existsSync(finalOutputDir);
    pairManifest.artifactRetention = {
      policy: 'one-completed-directory-per-case-and-platform',
      status: 'COMPLETE',
      replacedPrevious,
      removedStaleStagingDirectories: staleStaging.length,
      retainedVideoVariant: 'touch-evidence-only',
    };
    saveManifest(pairManifestFile, pairManifest);
    publishCompletedDirectory(outputDir, finalOutputDir);
    pairManifestFile = path.join(finalOutputDir, 'pair.json');
    try {
      pairManifest.dashboard = refreshCurrentDashboard(pairManifestFile, pairManifest);
      const buildManifestFile = pairManifest.dashboard
        ? path.join(path.dirname(pairManifest.dashboard), 'dashboard-manifest.json')
        : null;
      if (buildManifestFile && existsSync(buildManifestFile)) {
        const skipped = JSON.parse(readFileSync(buildManifestFile, 'utf8')).skippedEntries ?? [];
        if (skipped.length) pairManifest.dashboardSkippedEntries = skipped;
      }
      saveManifest(pairManifestFile, pairManifest);
    } catch (dashboardError) {
      pairManifest.dashboardError = dashboardError instanceof Error ? dashboardError.message : String(dashboardError);
      saveManifest(pairManifestFile, pairManifest);
    }
    console.log(pairManifestFile);
  }
  return pairManifestFile;
}

function uniqueParallelField(entries, field, required = true) {
  const values = entries.map((entry) => entry.pair[field]);
  if (required && values.some((value) => value === undefined || value === null || value === '')) {
    throw new Error(`Parallel pairs require an explicit unique ${field}`);
  }
  const present = values.filter((value) => value !== undefined && value !== null && value !== '');
  if (new Set(present.map(String)).size !== present.length) throw new Error(`Parallel pairs have duplicate ${field}`);
}

function bootAssignedDevice(device) {
  if (platformName(device) === 'iOS') {
    spawnSync('xcrun', ['simctl', 'boot', device.udid], { encoding: 'utf8' });
    const boot = spawnSync('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024,
    });
    if (boot.error?.code === 'ETIMEDOUT') throw new Error(`Simulator ${device.udid} boot timed out`);
    if (boot.status !== 0) throw new Error(`Simulator ${device.udid} boot failed: ${(boot.stderr || boot.stdout).trim()}`);
    bootedSimulator(device.udid);
    return { launched: true };
  }

    try {
      bootedAndroidDevice(device.udid);
      if (device.bootSettleMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(device.bootSettleMs));
      prepareAndroidNativeInput(device.udid);
      return { launched: false };
  } catch (error) {
    if (!device.avd) throw error;
  }
  const emulator = spawn('emulator', ['-avd', device.avd, '-no-snapshot-save', ...(device.emulatorArgs ?? [])], {
    detached: true,
    stdio: 'ignore',
  });
  emulator.unref();
  const wait = spawnSync('adb', ['-s', device.udid, 'wait-for-device'], { encoding: 'utf8', timeout: 120000 });
  if (wait.error?.code === 'ETIMEDOUT' || wait.status !== 0) throw new Error(`Android emulator ${device.avd} did not connect as ${device.udid}`);
  const started = Date.now();
  while (Date.now() - started < 120000) {
    try {
      bootedAndroidDevice(device.udid);
      if (device.bootSettleMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(device.bootSettleMs));
      prepareAndroidNativeInput(device.udid);
      return { launched: true };
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  throw new Error(`Android emulator ${device.avd} did not finish booting`);
}

function shutdownAssignedDevice(device, launch) {
  if (platformName(device) === 'iOS') {
    spawnSync('xcrun', ['simctl', 'shutdown', device.udid], { encoding: 'utf8', timeout: 30000 });
  } else if (launch?.launched) {
    spawnSync('adb', ['-s', device.udid, 'emu', 'kill'], { encoding: 'utf8', timeout: 30000 });
  }
}

async function runPairsParallel(pairList, outputOverride, environmentFile, simulatorList) {
  const pairFiles = pairList.split(',').map((item) => path.resolve(item.trim())).filter(Boolean);
  if (pairFiles.length < 2) throw new Error('parallel requires at least two comma-separated pair files');
  if (!environmentFile) throw new Error('parallel requires --environment');
  const simulatorNames = String(simulatorList ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (simulatorNames.length !== pairFiles.length) {
    throw new Error('parallel requires one comma-separated --simulators profile per pair');
  }
  const loadedEnvironment = loadEnvironment(environmentFile);
  const entries = pairFiles.map((file, index) => ({
    file,
    simulator: simulatorNames[index],
    pair: materializePair(JSON.parse(readFileSync(file, 'utf8')), file, loadedEnvironment, simulatorNames[index]),
  }));
  uniqueParallelField(entries.map((entry) => ({ pair: entry.pair.device })), 'udid');
  const iosEntries = entries.filter((entry) => platformName(entry.pair.device) === 'iOS');
  if (iosEntries.length) {
    uniqueParallelField(iosEntries, 'appiumPort');
    for (const field of ['wdaLocalPort', 'mjpegServerPort', 'derivedDataPath']) {
      uniqueParallelField(iosEntries, field, false);
    }
  }
  for (const { pair } of entries) bootedMobileDevice(pair.device);

  const outputDir = path.resolve(outputOverride || path.join(root, 'artifacts', 'parallel-batch'));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(outputDir, 'parallel.json');
  const manifest = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'RUNNING',
    node: process.version,
    pairs: entries.map(({ file, pair }) => ({ name: pair.name, file, device: pair.device.udid, status: 'RUNNING' })),
  };
  saveManifest(manifestFile, manifest);

  await Promise.all(entries.map(({ file, simulator }, index) => new Promise((resolve) => {
    const logFile = path.join(outputDir, `${String(index + 1).padStart(2, '0')}-${slug(entries[index].pair.name)}.log`);
    const output = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    const childArgs = [cliFile, 'pair', '--pair', file];
    if (environmentFile) childArgs.push('--environment', path.resolve(environmentFile));
    childArgs.push('--simulator', simulator);
    const child = spawn(process.execPath, childArgs, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); output.write(chunk); });
    child.stderr.pipe(output);
    child.once('close', (code) => {
      output.end();
      const pairManifest = stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith('/pair.json'));
      manifest.pairs[index] = {
        ...manifest.pairs[index],
        status: code === 0 ? 'COMPLETE' : 'INFRA_ERROR',
        exitCode: code,
        log: path.basename(logFile),
        pairManifest: pairManifest || null,
      };
      saveManifest(manifestFile, manifest);
      resolve();
    });
  })));
  manifest.completedAt = new Date().toISOString();
  manifest.status = manifest.pairs.every((item) => item.status === 'COMPLETE') ? 'COMPLETE' : 'INFRA_ERROR';
  saveManifest(manifestFile, manifest);
  console.log(manifestFile);
  if (manifest.status !== 'COMPLETE') process.exitCode = 1;
  return manifestFile;
}

async function runPairsSequential(pairList, outputOverride, environmentFile, simulatorName) {
  const pairFiles = pairList.split(',').map((item) => path.resolve(item.trim())).filter(Boolean);
  if (!pairFiles.length) throw new Error('sequence requires at least one pair file');
  const loadedEnvironment = loadEnvironment(environmentFile);
  const entries = pairFiles.map((file) => ({
    file,
    pair: materializePair(JSON.parse(readFileSync(file, 'utf8')), file, loadedEnvironment, simulatorName),
  }));
  const outputDir = path.resolve(outputOverride || path.join(root, 'artifacts', 'sequential-batch'));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(outputDir, 'sequence.json');
  const manifest = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'RUNNING',
    node: process.version,
    pairs: entries.map(({ file, pair }) => ({ name: pair.name, file, device: pair.device.udid, status: 'PENDING' })),
  };
  saveManifest(manifestFile, manifest);

  for (const [index, { file, pair }] of entries.entries()) {
    const entry = manifest.pairs[index];
    entry.status = 'BOOTING';
    entry.startedAt = new Date().toISOString();
    saveManifest(manifestFile, manifest);
    let launch;
    try {
      launch = bootAssignedDevice(pair.device);
      entry.status = 'RUNNING';
      saveManifest(manifestFile, manifest);
      const pairManifest = await runPair(file, undefined, environmentFile, simulatorName);
      const result = JSON.parse(readFileSync(pairManifest, 'utf8'));
      entry.status = result.status;
      entry.verdict = result.verdict;
      entry.reason = result.reason;
      entry.pairManifest = pairManifest;
    } catch (error) {
      entry.status = 'INFRA_ERROR';
      entry.reason = error instanceof Error ? error.message : String(error);
    } finally {
      shutdownAssignedDevice(pair.device, launch);
      entry.completedAt = new Date().toISOString();
      saveManifest(manifestFile, manifest);
    }
  }
  manifest.completedAt = new Date().toISOString();
  manifest.status = manifest.pairs.every((item) => item.status === 'COMPLETE') ? 'COMPLETE' : 'INFRA_ERROR';
  saveManifest(manifestFile, manifest);
  console.log(manifestFile);
  if (manifest.status !== 'COMPLETE') process.exitCode = 1;
  return manifestFile;
}

requireSupportedNode();
const command = process.argv[2];
const args = parseArgs({
  args: process.argv.slice(3),
  options: {
    pair: { type: 'string' },
    scenario: { type: 'string' },
    output: { type: 'string' },
    run: { type: 'string' },
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'pixel-threshold': { type: 'string' },
    'max-changed-pixel-ratio': { type: 'string' },
    profile: { type: 'string' },
    'max-transition-ratio-delta': { type: 'string' },
    status: { type: 'string' },
    reason: { type: 'string' },
    pairs: { type: 'string' },
    environment: { type: 'string' },
    simulator: { type: 'string' },
    simulators: { type: 'string' },
  },
});

if (command === 'doctor') doctor(args.values.environment);
else if (command === 'pair') {
  if (!args.values.pair) die('pair requires --pair');
  runPair(path.resolve(args.values.pair), args.values.output, args.values.environment, args.values.simulator).catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
} else if (command === 'run') {
  if (!args.values.scenario) die('run requires --scenario');
  runScenario(path.resolve(args.values.scenario), args.values.output).catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
} else if (command === 'judge') {
  if (!args.values.run || !args.values.status) die('judge requires --run and --status');
  judge(path.resolve(args.values.run), args.values.status, args.values.reason);
} else if (command === 'compare') {
  if (!args.values.baseline || !args.values.candidate || !args.values.from || !args.values.to) {
    die('compare requires --baseline, --candidate, --from, and --to');
  }
  compareRuns(
    path.resolve(args.values.baseline),
    path.resolve(args.values.candidate),
    args.values.from,
    args.values.to,
    args.values.output,
    {
      profile: args.values.profile,
      pixelThreshold: Number(args.values['pixel-threshold'] ?? 0.15),
      maxChangedPixelRatio: args.values['max-changed-pixel-ratio'] === undefined
        ? null
        : Number(args.values['max-changed-pixel-ratio']),
      maxTransitionRatioDelta: args.values['max-transition-ratio-delta'] === undefined
        ? null
        : Number(args.values['max-transition-ratio-delta']),
    },
  );
} else if (command === 'report') {
  if (!args.values.baseline || !args.values.candidate) {
    die('report requires --baseline and --candidate run.json files');
  }
  reportFromRuns(
    path.resolve(args.values.baseline),
    path.resolve(args.values.candidate),
    args.values.from,
    args.values.to,
    args.values.output,
    {
      profile: args.values.profile,
      pixelThreshold: Number(args.values['pixel-threshold'] ?? 0.15),
      maxChangedPixelRatio: args.values['max-changed-pixel-ratio'] === undefined
        ? null
        : Number(args.values['max-changed-pixel-ratio']),
      maxTransitionRatioDelta: args.values['max-transition-ratio-delta'] === undefined
        ? null
        : Number(args.values['max-transition-ratio-delta']),
    },
  );
} else if (command === 'parallel') {
  if (!args.values.pairs) die('parallel requires --pairs pair-a.json,pair-b.json');
  runPairsParallel(args.values.pairs, args.values.output, args.values.environment, args.values.simulators).catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
} else if (command === 'sequence') {
  if (!args.values.pairs) die('sequence requires --pairs pair-a.json,pair-b.json');
  runPairsSequential(args.values.pairs, args.values.output, args.values.environment, args.values.simulator).catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
} else {
  die('Usage: node src/cli.mjs doctor|pair|sequence|parallel|run|judge|compare|report');
}
