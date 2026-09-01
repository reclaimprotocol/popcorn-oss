import { describe, expect, test } from 'bun:test';
import { app } from '../index';

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('streamable http transport', () => {
  test('unauthenticated calls get a 401 with resource metadata', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  test('rejects a disallowed browser Origin', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  test('rejects an unsupported MCP-Protocol-Version', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' });
    expect(response.status).toBe(400);
  });

  test('rejects JSON-RPC batches', async () => {
    const response = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error.message).toContain('one JSON-RPC message per POST');
  });

  test('publishes protected-resource metadata for discovery', async () => {
    const response = await app.request('/.well-known/oauth-protected-resource');
    const body = (await response.json()) as any;
    expect(body.resource).toEndWith('/mcp');
  });
});

describe('authorization page', () => {
  test('renders no-login copy in Popcorn brand styling, and never mentions money', async () => {
    const registered = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }),
    });
    const client = (await registered.json()) as any;
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/cb',
      response_type: 'code',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      resource: 'http://localhost:3000/mcp',
    });
    const html = await (await app.request(`/oauth/authorize?${query}`)).text();
    expect(html).toContain('No login');
    expect(html).toContain('No account, no password, no email');
    expect(html).toContain('--yellow: #f7d93d');
    expect(html).toContain('Manrope');
    // The OSS authorization page knows nothing about payment.
    expect(html.toLowerCase()).not.toContain('stripe');
    expect(html).not.toContain('¢');
    expect(html).not.toContain('$');
  });
});

describe('no payment surface in the OSS server', () => {
  test('there is no Stripe webhook endpoint', async () => {
    const response = await app.request('/stripe/webhook', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  test('health reports the configured extension providers without exposing secrets', async () => {
    const body = (await (await app.request('/health')).json()) as any;
    expect(body.billing).toBe('none');
    expect(body.url_shortener).toBe('none');
    expect(JSON.stringify(body)).not.toContain('API_KEY');
  });
});
