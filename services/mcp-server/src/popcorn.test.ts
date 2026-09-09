import { afterEach, expect, test } from 'bun:test';
import { getSessionAttestation } from './popcorn';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockProof(reply: (url: URL) => Response | Promise<Response>, session: unknown = {
  sessionId: 'mcp_test', cdpInternalUrl: 'wss://regional.example/cdp-internal/mcp_test/secret/?old=1',
}) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (requests.length === 1) return Response.json(session);
    return reply(url);
  }) as typeof fetch;
  return requests;
}

test('requests fresh proof from the allocated regional gateway without credentials', async () => {
  const nonces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const requests = mockProof(url => {
      const nonce = url.searchParams.get('nonce');
      nonces.push(nonce!);
      return Response.json({ proof_version: 'v3', nonce, attestation: { token: 'evidence' } });
    });
    expect((await getSessionAttestation('mcp_test')).ok).toBe(true);
    expect(requests[0].url.pathname).toBe('/v1/session/mcp_test');
    expect(requests[1].url.origin).toBe('https://regional.example');
    expect(requests[1].url.pathname).toBe('/proof/mcp_test');
    expect(requests[1].url.searchParams.has('old')).toBe(false);
    expect(requests[1].init?.headers).toBeUndefined();
    expect(requests[1].init?.redirect).toBe('error');
    expect(nonces[i]).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(nonces[0]).not.toBe(nonces[1]);
});

test('preserves session lookup errors without requesting a proof', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: 'session expired' }, { status: 404 }); }) as typeof fetch;
  expect(await getSessionAttestation('gone')).toEqual({ ok: false, status: 404, error: 'session expired' });
  expect(calls).toBe(1);
});

for (const status of [404, 502, 503]) {
  test(`reports gateway HTTP ${status}`, async () => {
    mockProof(() => new Response('unavailable', { status }));
    expect(await getSessionAttestation('mcp_test')).toEqual({ ok: false, status, error: `Runtime proof request failed (HTTP ${status})` });
  });
}

for (const body of [{}, { proof_version: 'v3', nonce: 'wrong', attestation: { token: 'evidence' } }, null]) {
  test(`rejects incomplete or mismatched evidence: ${JSON.stringify(body)}`, async () => {
    mockProof(() => Response.json(body));
    expect((await getSessionAttestation('mcp_test')).ok).toBe(false);
  });
}

test('rejects an empty token even with a matching challenge', async () => {
  mockProof(url => Response.json({ proof_version: 'v3', nonce: url.searchParams.get('nonce'), attestation: { token: '' } }));
  expect((await getSessionAttestation('mcp_test')).ok).toBe(false);
});

test('handles network errors and malformed JSON', async () => {
  mockProof(() => { throw new Error('timeout'); });
  expect((await getSessionAttestation('mcp_test')).ok).toBe(false);
  mockProof(() => new Response('not json'));
  expect((await getSessionAttestation('mcp_test')).ok).toBe(false);
});

test('missing or invalid gateway never triggers another request', async () => {
  for (const session of [{ sessionId: 's' }, { sessionId: 's', cdpInternalUrl: 'file:///tmp/proof' }]) {
    const requests = mockProof(() => { throw Error('unexpected'); }, session);
    expect((await getSessionAttestation('s')).ok).toBe(false);
    expect(requests.length).toBe(1);
  }
});
