import { afterEach, expect, test } from 'bun:test';
import { handleRpc } from './mcp';
import { NoBillingProvider } from './billing';
import { InMemoryStore } from './store';
const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });
const nonce = '12'.repeat(32);
async function context() {
  const store = new InMemoryStore();
  await store.putSession({ sessionId: 's', subject: 'owner', purpose: 'test', createdAt: Date.now(), expiresAt: null, endedAt: null });
  return { store, subject: 'owner', billing: new NoBillingProvider() };
}
function call(ctx: any, args: any) {
  return handleRpc(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_runtime', arguments: args } }) as Promise<any>;
}
test('tool schema requires nonce and replaces the attested flag', async () => {
  const result: any = await handleRpc(await context(), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = result.result.tools.find((tool: any) => tool.name === 'verify_runtime');
  expect(tool.inputSchema.required).toEqual(['session_id', 'nonce']);
  expect(tool.outputSchema.properties.attested).toBeUndefined();
  expect(tool.outputSchema.properties.evidence_available).toBeDefined();
});
test('tool rejects missing nonce and unauthorized sessions without fetching', async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw Error('unexpected request'); }) as typeof fetch;
  const ctx = await context();
  expect((await call(ctx, { session_id: 's' })).result.isError).toBe(true);
  expect((await call({ ...ctx, subject: 'other' }, { session_id: 's', nonce })).result.isError).toBe(true);
  expect(requests).toBe(0);
});
test('tool returns caller challenge, evidence and honest verification scope', async () => {
  let requests = 0;
  globalThis.fetch = (async (url: any) => {
    requests++;
    if (requests === 1) return Response.json({ sessionId: 's', cdpInternalUrl: 'wss://regional.example/cdp-internal/s/secret' });
    expect(new URL(url).searchParams.get('nonce')).toBe(nonce);
    return Response.json({ proof_version: 'v3', nonce, attestation: { token: 'unverified-evidence' } });
  }) as typeof fetch;
  const response = await call(await context(), { session_id: 's', nonce });
  const payload = response.result.structuredContent;
  expect(payload.evidence_available).toBe(true);
  expect(payload.attested).toBeUndefined();
  expect(payload.attestation.nonce).toBe(nonce);
  expect(payload.verification.status).toBe('not_performed');
  expect(payload.verification.expected_nonce).toBe(nonce);
  expect(payload.verification.requested_session_id).toBe('s');
  expect(payload.verification.proves_after_verification).toHaveLength(5);
});
