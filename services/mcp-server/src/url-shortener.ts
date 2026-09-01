export type ShortLink = {
  code: string;
  short_url: string;
  url: string;
};

const POPC_LINKS_ENDPOINT = 'https://popc.click/api/links';
const DEFAULT_TIMEOUT_MS = 5_000;

function timeoutMs(): number {
  const configured = Number(process.env.MCP_URL_SHORTENER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

type ShortenerConfig = {
  provider: 'popc' | 'custom';
  endpoint: string;
  apiKey: string;
};

function shortenerConfig(): ShortenerConfig | null {
  const provider = (process.env.MCP_URL_SHORTENER_PROVIDER ?? 'none').trim().toLowerCase();
  if (!provider || provider === 'none') return null;

  const apiKey = (process.env.MCP_URL_SHORTENER_API_KEY ?? '').trim();
  if (provider === 'popc') {
    if (!apiKey) throw new Error('MCP_URL_SHORTENER_API_KEY is required for the popc provider');
    return { provider: 'popc', endpoint: POPC_LINKS_ENDPOINT, apiKey };
  }
  if (provider === 'custom') {
    const endpoint = (process.env.MCP_URL_SHORTENER_ENDPOINT ?? '').trim();
    if (!endpoint) throw new Error('MCP_URL_SHORTENER_ENDPOINT is required for a custom provider');
    return { provider: 'custom', endpoint, apiKey };
  }
  throw new Error(`unsupported MCP_URL_SHORTENER_PROVIDER: ${provider}`);
}

function isShortLink(value: unknown): value is ShortLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as Record<string, unknown>;
  return typeof link.code === 'string'
    && typeof link.short_url === 'string'
    && typeof link.url === 'string';
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Create a short link for a human-facing HTTP(S) URL using the configured
 * provider. Custom providers implement the same small JSON contract:
 * POST { url } -> { code, short_url, url }.
 *
 * The destination can contain a bearer credential, so failures deliberately
 * omit the response body and destination from the error message. Callers must
 * not use this for CDP: an HTTPS redirect is not a browser WebSocket endpoint.
 */
export async function shortenUrl(url: string): Promise<ShortLink> {
  const config = shortenerConfig();
  if (!config) throw new Error('URL shortening is disabled');

  if (!isHttpUrl(url)) {
    throw new Error('URL shorteners only support HTTP(S) destinations');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      throw new Error(`${config.provider} URL shortener failed (${response.status})`);
    }

    const body = await response.json() as unknown;
    if (!isShortLink(body)) throw new Error(`${config.provider} URL shortener returned an invalid response`);
    if (body.url !== url || !isHttpUrl(body.short_url)) {
      throw new Error(`${config.provider} URL shortener returned an unexpected link`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort LiveView shortening. The browser handoff must keep working when
 * the optional shortener is unconfigured, slow, or unavailable.
 */
export async function shortenLiveViewUrl(url: string | null): Promise<string | null> {
  if (!url) return url;
  try {
    if (!shortenerConfig()) return url;
    return (await shortenUrl(url)).short_url;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    console.warn(`LiveView URL shortening skipped: ${reason}`);
    return url;
  }
}
