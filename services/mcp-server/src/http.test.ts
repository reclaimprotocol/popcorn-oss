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
