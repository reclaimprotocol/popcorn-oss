function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  /** Suggested top-up amounts (US cents) surfaced to the agent. */
  topUpPresetsUsdCents: env('MCP_TOP_UP_PRESETS_USD_CENTS', '500,2000,5000')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0),
  /** Pricing. Popcorn credit is closed-loop: usable only for Popcorn sessions. */
  sessionPriceUsdCents: num('MCP_SESSION_PRICE_USD_CENTS', 5),
  /**
   * One purchase buys one fixed block of browser time. The duration is NOT
   * caller-controlled: a 5-cent charge must always buy the same thing.
   */
  sessionTtlSeconds: num('MCP_SESSION_TTL_SECONDS', 600),
  extendPriceUsdCents: num('MCP_EXTEND_PRICE_USD_CENTS', 5),
  /**
   * Card payments carry a fixed per-transaction fee, so a top-up has to be
   * worth charging: the minimum buys many sessions, and each session then
   * debits the prepaid balance with no further card transaction.
   */
  minTopUpUsdCents: num('MCP_MIN_TOP_UP_USD_CENTS', 500),
  maxTopUpUsdCents: num('MCP_MAX_TOP_UP_USD_CENTS', 50000),
  /** Durable storage. Unset means in-memory (dev/demo only). */
  databaseUrl: env('DATABASE_URL'),
  /** Stripe. Checkout is the only payment surface; the agent never sees card data. */
  stripeSecretKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  stripeApiBase: env('STRIPE_API_BASE', 'https://api.stripe.com'),
  topUpSuccessUrl: env('MCP_TOP_UP_SUCCESS_URL', ''),
  topUpCancelUrl: env('MCP_TOP_UP_CANCEL_URL', ''),
} as const;

export function requireStripe(): void {
  if (!McpConfig.stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured; top_up is unavailable');
  }
}
