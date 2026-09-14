import { randomBytes } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { getSessionAttestation } from './popcorn';

const challenge = 'ab'.repeat(32);
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
    const callerNonce = randomBytes(32).toString('hex');
    const requests = mockProof(url => {
      const nonce = url.searchParams.get('nonce');
      nonces.push(nonce!);
      return Response.json({ proof_version: 'v3', nonce, attestation: { token: 'evidence' } });
    });
    const result = await getSessionAttestation('mcp_test', callerNonce);
    expect(result.ok).toBe(true);
    expect(nonces[i]).toBe(callerNonce);
    if (result.ok) {
      expect(result.data.verification.status).toBe('not_performed');
      expect(result.data.verification.nonce_source).toBe('caller');
      expect(result.data.verification.requested_session_id).toBe('mcp_test');
      expect(result.data.verification.proves_after_verification).toHaveLength(5);
      expect(result.data.verification.audience_hint).toBe('https://regional.example');
    }
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
  expect(await getSessionAttestation('gone', challenge)).toEqual({ ok: false, status: 404, error: 'session expired' });
  expect(calls).toBe(1);
});

for (const status of [404, 502, 503]) {
  test(`reports gateway HTTP ${status}`, async () => {
    mockProof(() => new Response('unavailable', { status }));
    expect(await getSessionAttestation('mcp_test', challenge)).toEqual({ ok: false, status, error: `Runtime proof request failed (HTTP ${status})` });
  });
}

for (const body of [{}, { proof_version: 'v3', nonce: 'wrong', attestation: { token: 'evidence' } }, null]) {
  test(`rejects incomplete or mismatched evidence: ${JSON.stringify(body)}`, async () => {
    mockProof(() => Response.json(body));
    expect((await getSessionAttestation('mcp_test', challenge)).ok).toBe(false);
  });
}

test('rejects an empty token even with a matching challenge', async () => {
  mockProof(url => Response.json({ proof_version: 'v3', nonce: url.searchParams.get('nonce'), attestation: { token: '' } }));
  expect((await getSessionAttestation('mcp_test', challenge)).ok).toBe(false);
});

test('handles network errors and malformed JSON', async () => {
  mockProof(() => { throw new Error('timeout'); });
  expect((await getSessionAttestation('mcp_test', challenge)).ok).toBe(false);
  mockProof(() => new Response('not json'));
  expect((await getSessionAttestation('mcp_test', challenge)).ok).toBe(false);
});

test('missing or invalid gateway never triggers another request', async () => {
  for (const session of [{ sessionId: 's' }, { sessionId: 's', cdpInternalUrl: 'file:///tmp/proof' }]) {
    const requests = mockProof(() => { throw Error('unexpected'); }, session);
    expect((await getSessionAttestation('s', challenge)).ok).toBe(false);
    expect(requests.length).toBe(1);
  }
});

test('requires a caller challenge and never silently generates or normalizes it', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw Error('unexpected network request'); }) as typeof fetch;
  for (const nonce of [undefined, '', 'ab', 'AB'.repeat(32), 'ab'.repeat(33), 'g'.repeat(64), ' ' + challenge]) {
    const result = await getSessionAttestation('s', nonce as string);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  }
  expect(calls).toBe(0);
});

test('TEST ONLY: retrieves CS evidence with version-specific instructions, without claiming verification', async () => {
  // MOCK response, not real launcher evidence or a valid Google token.
  mockProof(() => Response.json({ proof_version: 'cs-v1', nonce: challenge, audience: 'https://verifier.example',
    run_public_key: 'A'.repeat(43), run_signature: 'A'.repeat(86), attestation: { token: 'TEST_ONLY_UNVERIFIED' } }));
  const result = await getSessionAttestation('mcp_test', challenge);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.data.verification.status).toBe('not_performed');
    expect(result.data.verification.required_claims).toContain('swname');
    expect(result.data.verification.required_claims).toContain('nbf');
    expect(result.data.verification.trusted_policy_required).toContain('proof_version');
    expect(result.data.verification.audience_hint).toBeNull();
    expect(result.data.verification.checks[0]).toContain('Reject legacy v3');
  }
});

test('TEST ONLY: rejects CS evidence without a run key or possession signature', async () => {
  for (const extra of [{}, { run_public_key: 'A'.repeat(43) }, { run_public_key: 'bad', run_signature: 'A'.repeat(86) }]) {
    mockProof(() => Response.json({ proof_version: 'cs-v1', nonce: challenge, audience: 'https://verifier.example',
      attestation: { token: 'TEST_ONLY_UNVERIFIED' }, ...extra }));
    expect((await getSessionAttestation('mcp_test', challenge)).ok).toBe(false);
  }
});
