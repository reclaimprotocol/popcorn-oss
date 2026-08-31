import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  defaultAndroidLaunchTarget,
  defaultIosLaunchTarget,
} from './launch-targets.mjs';

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Which app hosts the page, per platform. Chrome and Safari stay the defaults
// so existing environments keep working unchanged; the WebView shells cover
// pages that ship inside a host app's web view. An environment may add targets
// or override these under `android.launchTargets` and `ios.launchTargets`.
const builtInLaunchTargets = {
  Android: {
    chrome: defaultAndroidLaunchTarget,
    'webview-shell': {
      label: 'Android WebView',
      package: 'org.reclaimprotocol.popcorn.webviewshell',
      activity: 'org.reclaimprotocol.popcorn.webviewshell.ShellActivity',
      urlDelivery: 'extra',
      urlExtra: 'url',
      apk: path.join(harnessRoot, 'android', 'webview-shell', 'build', 'popcorn-webview-shell.apk'),
    },
  },
  iOS: {
    safari: defaultIosLaunchTarget,
    'webview-shell': {
      label: 'iOS WebView',
      bundleId: 'org.reclaimprotocol.popcorn.webviewshell',
      // simctl launch delivers the URL directly. A custom scheme would work too,
      // but iOS asks the tester to confirm opening the app, which no automated
      // run can answer.
      urlDelivery: 'launch-args',
      urlArgument: 'url',
      scheme: 'popcorn-shell',
      app: path.join(harnessRoot, 'ios', 'webview-shell', 'build', 'PopcornWebViewShell.app'),
    },
  },
};

const environmentSections = { Android: 'android', iOS: 'ios' };

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read environment ${file}: ${error.message}`);
  }
}

function merge(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return structuredClone(override);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return structuredClone(override ?? base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(result[key] ?? {}, value)
      : structuredClone(value);
  }
  return result;
}

function launchTargets(environment, platform) {
  const configured = environment[environmentSections[platform]]?.launchTargets ?? {};
  const builtIn = builtInLaunchTargets[platform];
  const names = new Set([...Object.keys(builtIn), ...Object.keys(configured)]);
  const result = {};
  for (const name of names) {
    result[name] = merge(builtIn[name] ?? {}, configured[name] ?? {});
  }
  return result;
}

export function resolveEnvironmentLaunchTargets(loadedEnvironment, platform) {
  if (!loadedEnvironment) return {};
  const targets = launchTargets(loadedEnvironment.value, platform);
  return Object.fromEntries(Object.keys(targets).sort().map((name) => [
    name,
    resolveLaunchTarget(name, platform, targets, loadedEnvironment.directory),
  ]));
}

function resolveAndroidLaunchTarget(resolved) {
  requireString(resolved.package, `android.launchTargets.${resolved.name}.package`);
  resolved.urlDelivery ??= 'view-intent';
  if (!['view-intent', 'extra'].includes(resolved.urlDelivery)) {
    throw new Error(`Android launch target ${resolved.name} urlDelivery must be view-intent or extra`);
  }
  if (resolved.urlDelivery === 'extra') {
    requireString(resolved.activity, `android.launchTargets.${resolved.name}.activity`);
    resolved.urlExtra ??= 'url';
  }
  return resolved;
}

function resolveIosLaunchTarget(resolved) {
  resolved.urlDelivery ??= 'open-url';
  if (!['open-url', 'launch-args', 'custom-scheme'].includes(resolved.urlDelivery)) {
    throw new Error(`iOS launch target ${resolved.name} urlDelivery must be open-url, launch-args, or custom-scheme`);
  }
  if (resolved.urlDelivery === 'open-url' && !resolved.bundleId) {
    // Safari and any other system handler: nothing to install, and the session
    // needs a browser name instead of a bundle id.
    requireString(resolved.browserName, `ios.launchTargets.${resolved.name}.browserName`);
  } else {
    requireString(resolved.bundleId, `ios.launchTargets.${resolved.name}.bundleId`);
  }
  if (resolved.urlDelivery === 'launch-args') resolved.urlArgument ??= 'url';
  if (resolved.urlDelivery === 'custom-scheme') {
    requireString(resolved.scheme, `ios.launchTargets.${resolved.name}.scheme`);
    resolved.urlQuery ??= 'url';
  }
  return resolved;
}

function resolveLaunchTarget(name, platform, targets, environmentDirectory) {
  const target = targets[name];
  if (!target) {
    throw new Error(`Environment has no ${platform} launch target named ${name} (available: ${Object.keys(targets).sort().join(', ')})`);
  }
  const resolved = { ...target, name };
  for (const key of ['apk', 'app']) {
    if (resolved[key] && !path.isAbsolute(resolved[key])) {
      resolved[key] = path.resolve(environmentDirectory, resolved[key]);
    }
  }
  resolved.label ??= name;
  return platform === 'Android' ? resolveAndroidLaunchTarget(resolved) : resolveIosLaunchTarget(resolved);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Environment requires ${label}`);
  return value;
}

function resolveUrl(base, relative, label) {
  try {
    return new URL(relative, base).toString();
  } catch {
    throw new Error(`Environment cannot resolve ${label}: base=${base} path=${relative}`);
  }
}

export function loadEnvironment(file, shellEnv = process.env) {
  if (!file) return null;
  const absolute = path.resolve(file);
  const environment = readJson(absolute);
  if (environment.schemaVersion !== 1) throw new Error('Environment schemaVersion must be 1');
  requireString(environment.name, 'name');
  if (environment.simulator && environment.simulators) {
    throw new Error('Environment must use simulators profiles, not both simulator and simulators');
  }

  const provider = environment.popcorn?.sessionProvider;
  if (provider) {
    const tokenVariable = provider.adminTokenEnv;
    const token = provider.adminToken ?? (tokenVariable ? shellEnv[tokenVariable] : null);
    if (!token) {
      throw new Error(`Environment requires ${tokenVariable ? `environment variable ${tokenVariable}` : 'popcorn.sessionProvider.adminTokenEnv'}`);
    }
    provider.adminToken = token;
  }
  return { file: absolute, directory: path.dirname(absolute), value: environment };
}

function selectSimulator(environment, requestedName) {
  if (environment.simulator) return { name: requestedName ?? 'default', value: environment.simulator };
  const profiles = environment.simulators ?? {};
  const names = Object.keys(profiles);
  const name = requestedName ?? environment.defaultSimulator ?? (names.length === 1 ? names[0] : null);
  if (!name) throw new Error('Environment requires --simulator or defaultSimulator when multiple simulator profiles exist');
  if (!profiles[name]) throw new Error(`Environment has no simulator profile named ${name}`);
  return { name, value: profiles[name] };
}

// Turn the launch target NAME a case may carry into the resolved target for each
// side. Kept out of materializePair: that function is the one place every
// environment rule lands, and each inline block makes the next one harder to
// follow (and to test) than the last.
function applySideLaunchTargets(result, environment, environmentDirectory) {
  const platform = String(result.device.platformName).toLowerCase() === 'android' ? 'Android' : 'iOS';
  const targets = launchTargets(environment, platform);
  const section = environment[environmentSections[platform]] ?? {};
  const fallback = result.launchTarget
    ?? section.defaultLaunchTarget
    ?? (platform === 'Android' ? 'chrome' : 'safari');
  for (const side of ['baseline', 'candidate']) {
    const name = result[side].launchTarget ?? fallback;
    if (typeof name !== 'string') throw new Error(`${side}.launchTarget must be a launch target name`);
    result[side].launchTarget = resolveLaunchTarget(name, platform, targets, environmentDirectory);
  }
  delete result.launchTarget;
  return result;
}

export function materializePair(pair, pairFile, loadedEnvironment, simulatorName) {
  const result = structuredClone(pair);
  if (!loadedEnvironment) return result;
  const environment = loadedEnvironment.value;
  const simulator = selectSimulator(environment, simulatorName);
  const defaults = environment.defaults ?? {};
  const popcorn = environment.popcorn ?? {};

  result.device = merge(simulator.value.device ?? {}, result.device ?? {});
  result.device.platformName ??= 'iOS';
  for (const key of ['appiumPort', 'wdaLocalPort', 'mjpegServerPort', 'derivedDataPath']) {
    if (result[key] === undefined && simulator.value[key] !== undefined) result[key] = simulator.value[key];
  }
  for (const key of ['settleMs', 'recordingLeadInMs', 'nativeOpenUrl', 'actionCoordinateScale']) {
    if (result[key] === undefined && defaults[key] !== undefined) result[key] = defaults[key];
  }

  result.baseline = merge({}, result.baseline ?? {});
  if (!result.baseline.url && result.baseline.fixturePath) {
    const base = requireString(environment.fixtures?.baseUrl, 'fixtures.baseUrl');
    result.baseline.url = resolveUrl(base, result.baseline.fixturePath, 'baseline.fixturePath');
  }

  result.candidate = merge({}, result.candidate ?? {});
  if (result.candidate.settleMs === undefined && defaults.candidateSettleMs !== undefined) {
    result.candidate.settleMs = defaults.candidateSettleMs;
  }
  if (popcorn.liveview || result.candidate.liveview) {
    result.candidate.liveview = merge(popcorn.liveview ?? {}, result.candidate.liveview ?? {});
    result.candidate.liveview.hostParams = merge(
      popcorn.liveview?.hostParams ?? {},
      result.candidate.liveview?.hostParams ?? {},
    );
  }
  if (popcorn.sessionProvider || result.sessionProvider) {
    result.sessionProvider = merge(popcorn.sessionProvider ?? {}, result.sessionProvider ?? {});
  }
  if (result.sessionProvider) {
    result.navigation = merge(
      { method: 'cdp-page-navigate', source: 'baseline' },
      merge(popcorn.navigation ?? {}, result.navigation ?? {}),
    );
  } else if (popcorn.navigation || result.navigation) {
    result.navigation = merge(popcorn.navigation ?? {}, result.navigation ?? {});
  }
  applySideLaunchTargets(result, environment, loadedEnvironment.directory);
  result.environment = {
    name: environment.name,
    simulator: simulator.name,
    file: path.relative(path.dirname(pairFile), loadedEnvironment.file),
  };
  return result;
}

function curlCheck(check) {
  const args = ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', String(check.timeoutSeconds ?? 5), check.url];
  const command = check.via === 'ssh'
    ? ['ssh', [check.ssh, 'curl', ...args]]
    : ['curl', args];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', timeout: (check.timeoutSeconds ?? 5) * 1000 + 3000 });
  const statusCode = Number(result.stdout?.trim());
  const accepted = check.acceptStatuses ?? [200];
  return {
    name: check.name ?? check.url,
    ok: result.status === 0 && accepted.includes(statusCode),
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    error: result.status === 0 ? null : (result.stderr || result.error?.message || `exit ${result.status}`).trim(),
  };
}

// A fixture host addressed by a DHCP address stops answering the moment the lease
// moves, and the failure surfaces far from its cause: the simulator and the remote
// kiosk simply stop reaching the fixtures, so a page never loads or a stale one
// stays up and cases fail for reasons that look like the product. The address is
// still the operator's to choose — the kiosk runs in a container, so loopback is
// not a substitute — but when a check against a private literal fails, say whether
// this machine still answers to that address.
function localIPv4Addresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function staleAddressHint(url, error) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return null;
  const local = localIPv4Addresses();
  if (local.includes(hostname)) return null;
  return `${error} — this machine is not ${hostname}`
    + (local.length ? ` (its addresses: ${local.join(', ')})` : ' (it has no external IPv4 address)');
}

export function checkEnvironment(loadedEnvironment) {
  if (!loadedEnvironment) return [];
  return (loadedEnvironment.value.healthChecks ?? []).map((check) => {
    if (!check.url) return { name: check.name ?? 'unnamed check', ok: false, error: 'missing url' };
    if (check.via === 'ssh' && !check.ssh) return { name: check.name ?? check.url, ok: false, error: 'missing ssh target' };
    const result = curlCheck(check);
    // Only for a check reached from THIS machine: over ssh the address is resolved
    // somewhere else and our interfaces say nothing about it.
    if (!result.ok && result.error && check.via !== 'ssh') {
      result.error = staleAddressHint(check.url, result.error) ?? result.error;
    }
    return result;
  });
}
