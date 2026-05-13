import { existsSync, readFileSync } from 'fs';

export interface RegionConfig {
  name: string;
  clusterName: string;
  poolManagerUrl: string;
  publicGatewayUrl: string;
  enabled: boolean;
  serviceAuthToken?: string;
  serviceAuthTokenFile?: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseRegions(raw: string | undefined): RegionConfig[] {
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid CONTROL_PLANE_REGIONS JSON: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('CONTROL_PLANE_REGIONS must be a JSON array');
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Region entry at index ${index} must be an object`);
    }

    const region = entry as Record<string, unknown>;
    const name = String(region.name || '').trim();
    const clusterName = String(region.clusterName || '').trim();
    const poolManagerUrl = String(region.poolManagerUrl || '').trim();
    const publicGatewayUrl = String(region.publicGatewayUrl || '').trim();
    const serviceAuthToken = String(region.serviceAuthToken || '').trim();
    const serviceAuthTokenFile = String(region.serviceAuthTokenFile || '').trim();

    if (!name || !clusterName || !poolManagerUrl || !publicGatewayUrl) {
      throw new Error(`Region entry at index ${index} is missing name, clusterName, poolManagerUrl, or publicGatewayUrl`);
    }

    return {
      name,
      clusterName,
      poolManagerUrl: trimTrailingSlash(poolManagerUrl),
      publicGatewayUrl: trimTrailingSlash(publicGatewayUrl),
      enabled: region.enabled !== false,
      serviceAuthToken: serviceAuthToken || readSecretFile(serviceAuthTokenFile),
      serviceAuthTokenFile: serviceAuthTokenFile || undefined,
    };
  });
}

export function requireEnv(name: string): string {
  const value = readOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = readOptionalEnv(name);
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required environment variable: ${names.join(' or ')}`);
}

function readSecretFile(path: string): string | undefined {
  if (!path || !existsSync(path)) {
    return undefined;
  }
  const value = readFileSync(path, 'utf8').trim();
  return value || undefined;
}

export const ControlPlaneConfig = {
  port: Number(readOptionalEnv('PORT') || '3000'),
  serviceAuthToken: requireAnyEnv(['CONTROL_PLANE_SERVICE_AUTH_TOKEN', 'SERVICE_AUTH_TOKEN', 'CONTROL_PLANE_AUTH_TOKEN', 'ANALYTICS_AUTH_TOKEN']),
  adminToken: readOptionalEnv('CONTROL_PLANE_ADMIN_TOKEN') || readOptionalEnv('ADMIN_TOKEN'),
  regions: parseRegions(readOptionalEnv('CONTROL_PLANE_REGIONS')),
};
