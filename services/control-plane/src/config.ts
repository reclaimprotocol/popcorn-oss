import { existsSync, readFileSync } from 'fs';
import { readTtlConfig } from './ttl';

export interface RegionConfig {
  name: string;
  clusterName: string;
  poolManagerUrl: string;
  publicGatewayUrl: string;
  enabled: boolean;
  x402Only?: boolean;
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

function readBooleanEnv(name: string, fallback = false): boolean {
  const value = readOptionalEnv(name);
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = readOptionalEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = readOptionalEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function readJsonHeaders(name: string): Record<string, string> | undefined {
  const value = readOptionalEnv(name);
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.values(parsed).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${name} must be a JSON object whose values are strings`);
  }
  return parsed as Record<string, string>;
}

export interface X402Config {
  enabled: boolean;
  regionName?: string;
  payTo?: string;
  publicBaseUrl?: string;
  rpcUrl?: string;
  network: 'eip155:8453' | 'eip155:84532';
  facilitatorUrl: string;
  facilitatorAuthHeaders?: Record<string, string>;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  serverSecret?: string;
  blockSeconds: number;
  pricePerBlockAtomic: number;
  maxExtensionBlocks: number;
  maxPaidBlocks: number;
  trustedProxyHops: number;
  rateLimitPerMinute: number;
}

export function readX402Config(): X402Config {
  const enabled = readBooleanEnv('X402_ENABLED');
  const testnet = readBooleanEnv('X402_TESTNET');
  const requestedNetwork = readOptionalEnv('X402_NETWORK');
  const network = requestedNetwork || (testnet ? 'eip155:84532' : 'eip155:8453');
  if (network !== 'eip155:8453' && network !== 'eip155:84532') {
    throw new Error('X402_NETWORK must be Base mainnet (eip155:8453) or Base Sepolia (eip155:84532)');
  }

  const config: X402Config = {
    enabled,
    regionName: readOptionalEnv('X402_REGION_NAME'),
    payTo: readOptionalEnv('X402_PAY_TO'),
    publicBaseUrl: readOptionalEnv('X402_PUBLIC_BASE_URL'),
    rpcUrl: readOptionalEnv('X402_BASE_RPC_URL'),
    network,
    facilitatorUrl: readOptionalEnv('X402_FACILITATOR_URL')
      || (network === 'eip155:8453'
        ? 'https://api.cdp.coinbase.com/platform/v2/x402'
        : 'https://x402.org/facilitator'),
    facilitatorAuthHeaders: readJsonHeaders('X402_FACILITATOR_AUTH_HEADERS'),
    cdpApiKeyId: readOptionalEnv('CDP_API_KEY_ID'),
    cdpApiKeySecret: readOptionalEnv('CDP_API_KEY_SECRET'),
    // The old environment name remains a temporary deployment fallback. This
    // secret is server-side only and is never sent to an x402 client.
    serverSecret: readOptionalEnv('X402_SERVER_SECRET')
      || readOptionalEnv('X402_MANAGEMENT_TOKEN_SECRET'),
    blockSeconds: 300,
    pricePerBlockAtomic: 10_000,
    maxExtensionBlocks: readPositiveIntegerEnv('X402_MAX_EXTENSION_BLOCKS', 12),
    maxPaidBlocks: readPositiveIntegerEnv('X402_MAX_PAID_BLOCKS', 12),
    trustedProxyHops: readNonNegativeIntegerEnv('X402_TRUSTED_PROXY_HOPS', 1),
    rateLimitPerMinute: readPositiveIntegerEnv('X402_RATE_LIMIT_PER_MINUTE', 30),
  };

  if (enabled) {
    if (!config.regionName) throw new Error('Missing required environment variable: X402_REGION_NAME');
    if (!config.rpcUrl) throw new Error('Missing required environment variable: X402_BASE_RPC_URL');
    try {
      const rpcUrl = new URL(config.rpcUrl);
      if (rpcUrl.protocol !== 'https:' || rpcUrl.username || rpcUrl.password) throw new Error('invalid');
    } catch {
      throw new Error('X402_BASE_RPC_URL must be an HTTPS Base RPC URL without embedded credentials');
    }
    if (!config.publicBaseUrl) throw new Error('Missing required environment variable: X402_PUBLIC_BASE_URL');
    try {
      const publicBaseUrl = new URL(config.publicBaseUrl);
      if (publicBaseUrl.protocol !== 'https:' || publicBaseUrl.username || publicBaseUrl.password
        || publicBaseUrl.search || publicBaseUrl.hash || publicBaseUrl.pathname !== '/') throw new Error('invalid');
      config.publicBaseUrl = publicBaseUrl.toString().replace(/\/$/, '');
    } catch {
      throw new Error('X402_PUBLIC_BASE_URL must be a canonical HTTPS origin without path, credentials, query, or fragment');
    }
    if (!config.payTo || !/^0x[a-fA-F0-9]{40}$/.test(config.payTo)) {
      throw new Error('X402_PAY_TO must be a valid EVM address');
    }
    if (config.network === 'eip155:8453'
      && config.facilitatorUrl === 'https://x402.org/facilitator') {
      throw new Error('The x402.org facilitator is testnet-only and cannot be used with Base mainnet');
    }
    if (config.facilitatorUrl.startsWith('https://api.cdp.coinbase.com/')
      && (!config.cdpApiKeyId || !config.cdpApiKeySecret)) {
      throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for the CDP facilitator');
    }
    if (!config.serverSecret || config.serverSecret.length < 32) {
      throw new Error('X402_SERVER_SECRET must contain at least 32 characters');
    }
  }
  return config;
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
      x402Only: region.x402Only === true,
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

function readSecretFile(path: string): string | undefined {
  if (!path || !existsSync(path)) {
    return undefined;
  }
  const value = readFileSync(path, 'utf8').trim();
  return value || undefined;
}

const configuredRegions = parseRegions(readOptionalEnv('CONTROL_PLANE_REGIONS'));
const x402Config = readX402Config();
if (x402Config.enabled) {
  const matches = configuredRegions.filter((region) => region.name === x402Config.regionName && region.enabled);
  if (matches.length !== 1 || matches[0]?.x402Only !== true) {
    throw new Error('X402_REGION_NAME must match exactly one enabled region explicitly marked x402Only');
  }
}

export const ControlPlaneConfig = {
  port: Number(readOptionalEnv('PORT') || '3000'),
  serviceAuthToken: requireEnv('CONTROL_PLANE_SERVICE_AUTH_TOKEN'),
  adminToken: readOptionalEnv('CONTROL_PLANE_ADMIN_TOKEN') || readOptionalEnv('ADMIN_TOKEN'),
  regions: configuredRegions,
  sessionMaxTtlSeconds: readTtlConfig().maxTtlSeconds,
  x402: x402Config,
};
