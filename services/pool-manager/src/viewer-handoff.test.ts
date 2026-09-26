import { describe, expect, test } from 'bun:test';
import { handoffSession, readViewerHandoffStatus, ViewerHandoffConflict, type ViewerHandoffDependencies } from './viewer-handoff';
import type { Pod } from './types';

const body = { clientId: 'client-1', expectedPodUid: 'pod-uid-1' };
const url = 'http://10.0.0.1:6080/_popcorn/viewer-handoff-status';
const ack = { version: 1, state: 'revoked', sessionId: 'session-1', podUid: body.expectedPodUid, runtimeInstanceId: 'a'.repeat(32) };
function fixture() {
  let current: Pod | null = {
    name: 'browser-1', namespace: 'default', url: 'http://10.0.0.1:6080',
    podUid: body.expectedPodUid, clientId: body.clientId,
    boundAt: '2026-09-24T00:00:00.000Z', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const calls: string[] = [];
  const dependencies: ViewerHandoffDependencies = {
    namespace: 'default',
    getSession: async () => { calls.push('session'); return current ? { ...current } : null; },
    inspectHandoff: async () => { calls.push('inspect'); return url; },
    requestHandoff: async () => { calls.push('request'); return url; },
    confirmHandoff: async () => { calls.push('confirm'); return url; },
    readStatus: async () => { calls.push('status'); return { ...ack }; },
  };
  return { dependencies, calls, get current() { return current; }, set current(value) { current = value; } };
}
const run = (f: ReturnType<typeof fixture>, input: unknown = body) => handoffSession('session-1', input, f.dependencies, { timeoutMs: 40, pollMs: 1 });

describe('allocation-bound viewer handoff', () => {
  test('returns only a fresh runtime receipt and leaves session data unchanged', async () => {
    const f = fixture();
    const original = structuredClone(f.current);
    const result = await run(f);
    expect(result).toEqual({ status: 200, body: {
      success: true, sessionId: 'session-1', podUid: body.expectedPodUid,
      viewerAccess: 'revoked', runtimeInstanceId: ack.runtimeInstanceId, expiresAt: original!.expiresAt,
    } });
    expect(f.current).toEqual(original);
    expect(f.calls).toEqual(['session', 'inspect', 'status', 'session', 'request', 'status', 'session', 'confirm', 'status', 'session']);
    expect((await run(f)).status).toBe(200);
  });
  test.each([null, {}, [], { ...body, expectedPodUid: '../pod' }, { ...body, owner: 'attacker' }])('rejects malformed input before dependencies (%j)', async input => {
    const f = fixture();
    expect((await run(f, input)).status).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test('hides missing and other-owner sessions', async () => {
    const f = fixture();
    f.current!.clientId = 'someone-else';
    expect((await run(f)).status).toBe(404);
    f.current = null;
    expect((await run(f)).status).toBe(404);
    expect(f.calls).toEqual(['session', 'session']);
  });
  test.each(['uid', 'boundAt', 'expired', 'automation'])('rejects unsupported allocation %s', async change => {
    const f = fixture();
    if (change === 'uid') f.current!.podUid = 'other-uid';
    if (change === 'boundAt') f.current!.boundAt = undefined;
    if (change === 'expired') f.current!.expiresAt = new Date(0).toISOString();
    if (change === 'automation') f.current!.accessPolicy = { tokenMode: 'expiring', cdpScope: 'automation' };
    expect((await run(f)).status).toBe(409);
    expect(f.calls).toEqual(['session']);
  });
  test.each([null, { ...ack, version: 2 }, { ...ack, state: 'unconfirmed' }, { ...ack, sessionId: 'old-session' }, { ...ack, podUid: 'old-pod' }, { ...ack, runtimeInstanceId: '' }])('does not persist a request before compatible runtime preflight (%j)', async status => {
    const f = fixture();
    f.dependencies.readStatus = async () => status;
    expect((await run(f)).status).toBe(409);
    expect(f.calls).not.toContain('request');
  });
  test.each(['active', 'revoking', 'unconfirmed', 'wrong-uid', 'old-version', 'missing-nonce'])('does not treat pending or invalid runtime status as success (%s)', async state => {
    const f = fixture();
    let reads = 0;
    f.dependencies.readStatus = async () => {
      if (++reads === 1) return ack;
      if (state === 'wrong-uid') return { ...ack, podUid: 'wrong' };
      if (state === 'old-version') return { ...ack, version: 0 };
      if (state === 'missing-nonce') return { ...ack, runtimeInstanceId: undefined };
      return { ...ack, state };
    };
    expect((await run(f)).status).toBe(504);
  });
  test.each(['deleted', 'reallocated', 'expired', 'owner', 'boundAt'])('rejects %s while revocation is pending', async change => {
    const f = fixture();
    f.dependencies.confirmHandoff = async () => {
      if (change === 'deleted') f.current = null;
      if (change === 'reallocated') f.current!.podUid = 'new-pod';
      if (change === 'expired') f.current!.expiresAt = new Date(0).toISOString();
      if (change === 'owner') f.current!.clientId = 'new-owner';
      if (change === 'boundAt') f.current!.boundAt = '2026-09-24T01:00:00.000Z';
      return url;
    };
    expect((await run(f)).status).toBe(409);
  });
  test('does not reuse the acknowledgement of a previous runtime process', async () => {
    const f = fixture();
    let reads = 0;
    f.dependencies.readStatus = async () => ({ ...ack, runtimeInstanceId: (++reads % 2 ? 'a' : 'b').repeat(32) });
    expect((await run(f)).status).toBe(504);
  });
  test('rejects a failed conditional Kubernetes patch', async () => {
    const f = fixture();
    f.dependencies.requestHandoff = async () => { throw new ViewerHandoffConflict(); };
    expect((await run(f)).status).toBe(409);
    expect(f.calls).not.toContain('confirm');
  });
  test.each(['getSession', 'inspectHandoff', 'requestHandoff', 'confirmHandoff', 'readStatus'] as const)('bounds a stalled %s operation', async method => {
    const f = fixture();
    f.dependencies[method] = (() => new Promise(() => {})) as any;
    expect((await run(f)).status).toBe(504);
  });
  test('never acknowledges after synchronous work has exceeded the deadline', async () => {
    const f = fixture();
    let reads = 0;
    f.dependencies.getSession = async () => {
      if (++reads === 4) { const until = Date.now() + 60; while (Date.now() < until) {} }
      return f.current;
    };
    expect((await run(f)).status).toBe(504);
  });
  test('runtime body reader rejects oversized status without exposing it', async () => {
    const previous = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('x'.repeat(5000))) as unknown as typeof fetch;
      await expect(readViewerHandoffStatus(url, new AbortController().signal)).rejects.toThrow('Invalid bounded JSON body');
    } finally { globalThis.fetch = previous; }
  });
});
