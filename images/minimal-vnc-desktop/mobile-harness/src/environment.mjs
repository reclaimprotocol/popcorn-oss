import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

export function materializePair(pair, pairFile, loadedEnvironment, simulatorName) {
  const result = structuredClone(pair);
  if (!loadedEnvironment) return result;
  const environment = loadedEnvironment.value;
  const simulator = selectSimulator(environment, simulatorName);
  const defaults = environment.defaults ?? {};
  const popcorn = environment.popcorn ?? {};

  result.device = merge(simulator.value.device ?? {}, result.device ?? {});
  for (const key of ['appiumPort', 'wdaLocalPort', 'mjpegServerPort', 'derivedDataPath']) {
    if (result[key] === undefined && simulator.value[key] !== undefined) result[key] = simulator.value[key];
  }
  for (const key of ['settleMs', 'recordingLeadInMs', 'nativeOpenUrl']) {
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

export function checkEnvironment(loadedEnvironment) {
  if (!loadedEnvironment) return [];
  return (loadedEnvironment.value.healthChecks ?? []).map((check) => {
    if (!check.url) return { name: check.name ?? 'unnamed check', ok: false, error: 'missing url' };
    if (check.via === 'ssh' && !check.ssh) return { name: check.name ?? check.url, ok: false, error: 'missing ssh target' };
    return curlCheck(check);
  });
}
