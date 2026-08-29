function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function databaseUrl(): string {
  const direct = env('DATABASE_URL');
  if (direct) return direct;
  const host = env('POSTGRES_HOST');
  const database = env('POSTGRES_DB');
  const user = env('POSTGRES_USER');
  const password = env('POSTGRES_PASSWORD');
  if (!host || !database || !user || !password) return '';
  const port = env('POSTGRES_PORT', '5432');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export const McpConfig = {
  port: num('PORT', 3000),
  /** Public origin of this MCP server; used for OAuth metadata and redirects. */
  publicUrl: env('MCP_PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  /** Popcorn control-plane base URL and the operator client this server acts as. */
  controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://control-plane:3000').replace(/\/$/, ''),
  controlPlaneClientId: env('POPCORN_CLIENT_ID'),
  controlPlaneClientSecret: env('POPCORN_CLIENT_SECRET'),
  /** Signing key for access/authorization codes issued by this server. */
  tokenSigningKey: env('MCP_TOKEN_SIGNING_KEY', 'dev-only-insecure-key'),
  accessTokenTtlSeconds: num('MCP_ACCESS_TOKEN_TTL_SECONDS', 3600),
  /**
   * One fixed block of browser time per billed operation. The duration is
   * server-side, never caller-controlled.
   */
  sessionTtlSeconds: num('MCP_SESSION_TTL_SECONDS', 600),
  /** How long one worker owns an operation before a retry may recover it. */
  operationLeaseSeconds: num('MCP_OPERATION_LEASE_SECONDS', 120),
  /**
   * Billing. `none` (default) meters nothing — the right choice for
   * self-hosters. `external` delegates balance/reserve/commit/release to an
   * operator-run HTTP service; see src/billing.ts. This server has no concept
   * of money, currency, checkout or pricing.
   */
  billingProvider: (env('MCP_BILLING_PROVIDER', 'none') as 'none' | 'external'),
  billingBaseUrl: env('MCP_BILLING_BASE_URL').replace(/\/$/, ''),
  billingAuthToken: env('MCP_BILLING_AUTH_TOKEN'),
  /** Durable storage. Unset means in-memory (dev/demo only). */
  databaseUrl: databaseUrl(),
} as const;

export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = [
    ['DATABASE_URL or POSTGRES_*', McpConfig.databaseUrl],
    ['POPCORN_CLIENT_ID', McpConfig.controlPlaneClientId],
    ['POPCORN_CLIENT_SECRET', McpConfig.controlPlaneClientSecret],
    ['MCP_TOKEN_SIGNING_KEY', McpConfig.tokenSigningKey !== 'dev-only-insecure-key' ? McpConfig.tokenSigningKey : ''],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (!McpConfig.publicUrl.startsWith('https://')) missing.push('MCP_PUBLIC_URL (https required)');
  if (McpConfig.tokenSigningKey.length < 32) missing.push('MCP_TOKEN_SIGNING_KEY (minimum 32 characters)');
  if (McpConfig.billingProvider === 'external') {
    if (!McpConfig.billingBaseUrl) missing.push('MCP_BILLING_BASE_URL');
    if (!McpConfig.billingAuthToken) missing.push('MCP_BILLING_AUTH_TOKEN');
    else if (McpConfig.billingAuthToken.length < 32) missing.push('MCP_BILLING_AUTH_TOKEN (minimum 32 characters)');
  }
  if (missing.length) throw new Error(`Refusing to start: missing production configuration: ${missing.join(', ')}`);
}
