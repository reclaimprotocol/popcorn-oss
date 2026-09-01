import { afterEach, describe, expect, test } from 'bun:test';
import { shortenLiveViewUrl, shortenUrl } from './url-shortener';

const ENV_NAMES = [
  'MCP_URL_SHORTENER_PROVIDER',
  'MCP_URL_SHORTENER_ENDPOINT',
  'MCP_URL_SHORTENER_API_KEY',
  'MCP_URL_SHORTENER_TIMEOUT_MS',
] as const;

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('optional URL shortening', () => {
  test('is disabled by default and does not call a third party', async () => {
    delete process.env.MCP_URL_SHORTENER_PROVIDER;
    globalThis.fetch = (async () => {
      throw new Error('fetch must not be called');
    }) as unknown as typeof fetch;

    const original = 'https://view.example/live/token/liveview.html?resize=scale';
    expect(await shortenLiveViewUrl(original)).toBe(original);
  });

  test('uses the built-in popc provider only when explicitly selected', async () => {
    process.env.MCP_URL_SHORTENER_PROVIDER = 'popc';
    process.env.MCP_URL_SHORTENER_API_KEY = 'test-key';
    const original = 'https://view.example/live/opaque-token/liveview.html?resize=scale';

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://popc.click/api/links');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
      expect(JSON.parse(String(init?.body))).toEqual({ url: original });
      return Response.json({ code: 'abc', short_url: 'https://popc.click/abc', url: original });
    }) as typeof fetch;

    expect(await shortenLiveViewUrl(original)).toBe('https://popc.click/abc');
  });

  test('supports an operator-provided compatible endpoint without requiring auth', async () => {
    process.env.MCP_URL_SHORTENER_PROVIDER = 'custom';
    process.env.MCP_URL_SHORTENER_ENDPOINT = 'https://short.example/api/links';
    delete process.env.MCP_URL_SHORTENER_API_KEY;
    const original = 'https://view.example/live/opaque';

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://short.example/api/links');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json({ code: 'xyz', short_url: 'https://short.example/xyz', url: original });
    }) as typeof fetch;

    expect((await shortenUrl(original)).short_url).toBe('https://short.example/xyz');
  });

  test('fails open when the optional provider is unavailable', async () => {
    process.env.MCP_URL_SHORTENER_PROVIDER = 'custom';
    process.env.MCP_URL_SHORTENER_ENDPOINT = 'https://short.example/api/links';
    console.warn = () => {};
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    const original = 'https://view.example/live/opaque';

    expect(await shortenLiveViewUrl(original)).toBe(original);
  });

  test('rejects non-HTTP CDP endpoints and unexpected provider responses', async () => {
    process.env.MCP_URL_SHORTENER_PROVIDER = 'custom';
    process.env.MCP_URL_SHORTENER_ENDPOINT = 'https://short.example/api/links';
    await expect(shortenUrl('wss://cdp.example/devtools?token=opaque')).rejects.toThrow('HTTP(S)');

    const original = 'https://view.example/live/opaque';
    globalThis.fetch = (async () => Response.json({
      code: 'bad',
      short_url: 'https://short.example/bad',
      url: 'https://different.example/',
    })) as unknown as typeof fetch;
    await expect(shortenUrl(original)).rejects.toThrow('unexpected link');
  });
});
