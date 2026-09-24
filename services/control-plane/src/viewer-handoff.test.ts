import { describe, expect, test } from 'bun:test';
import { handoffRoutedSession } from './viewer-handoff';
import { handoffRegionalSession } from './pool-manager';
import type { RegionConfig } from './config';

const region: RegionConfig = { name: 'test-region', clusterName: 'cluster', poolManagerUrl: 'http://pool.test', publicGatewayUrl: 'https://gateway.test', enabled: true };
const ack = { success: true, sessionId: 'session-1', podUid: 'pod-1', viewerAccess: 'revoked', runtimeInstanceId: 'a'.repeat(32) };
function fixture() {
  let current: { clientId: string; status: string; region: string; metadata: unknown } | null = {
    clientId: 'owner', status: 'active', region: region.name,
    metadata: { sessionBoundAt: '2026-09-24T10:00:00.000Z' },
  };
  const calls: unknown[][] = [];
  const dependencies = {
    getSession: async (_id: string) => current ? { ...current } : null,
    resolveRegion: () => region as RegionConfig | null,
    handoff: async (...args: unknown[]) => { calls.push(args); return { response: Response.json(ack), body: { ...ack } as unknown }; },
  };
  return { calls, dependencies, get current() { return current; }, set current(value) { current = value; } };
}
const run = (f: ReturnType<typeof fixture>, body: unknown = { expectedPodUid: 'pod-1' }, timeoutMs = 100) => handoffRoutedSession('session-1', 'owner', body, f.dependencies, timeoutMs);

describe('credentialed viewer handoff', () => {
  test('routes only the authenticated owner and returns a narrow receipt', async () => {
    const f = fixture();
    f.dependencies.handoff = async (...args) => {
      f.calls.push(args);
      return { response: Response.json(ack), body: { ...ack, cdpUrl: 'private-token', unknown: true } };
    };
    expect(await run(f)).toEqual({ status: 200, body: ack });
    expect(f.calls[0]!.slice(0, 4)).toEqual([region, 'session-1', 'owner', 'pod-1']);
    expect(f.calls[0]![4]).toBeInstanceOf(AbortSignal);
  });
  test.each([null, [], {}, { expectedPodUid: '../pod' }, { expectedPodUid: 'pod-1', clientId: 'attacker' }])('rejects malformed or spoofed input (%j)', async body => {
    const f = fixture();
    expect((await run(f, body)).status).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test.each(['absent', 'owner', 'inactive', 'region'])('does not request handoff for %s', async change => {
    const f = fixture();
    if (change === 'absent') f.current = null;
    if (change === 'owner') f.current!.clientId = 'other';
    if (change === 'inactive') f.current!.status = 'deleted';
    if (change === 'region') f.dependencies.resolveRegion = () => null;
    expect((await run(f)).status).toBe(['absent', 'owner'].includes(change) ? 404 : 409);
    expect(f.calls).toEqual([]);
  });
  test.each([null, { ...ack, viewerAccess: 'active' }, { ...ack, podUid: 'stale-pod' }, { ...ack, sessionId: 'other' }, { ...ack, runtimeInstanceId: '' }, { ...ack, expiresAt: new Date(0).toISOString() }])('rejects an invalid downstream acknowledgement (%j)', async value => {
    const f = fixture();
    f.dependencies.handoff = async () => ({ response: Response.json(value), body: value });
    expect((await run(f)).status).toBe(502);
  });
  test('rechecks active ownership after runtime acknowledgement', async () => {
    const f = fixture();
    f.dependencies.handoff = async () => {
      f.current!.status = 'deleted';
      return { response: Response.json(ack), body: ack };
    };
    expect((await run(f)).status).toBe(409);
  });
  test.each([null, undefined, [], {}, { sessionBoundAt: '' }, { sessionBoundAt: 123 }, { sessionBoundAt: 'invalid' }])('rejects an unavailable allocation binding (%j)', async metadata => {
    const f = fixture();
    f.current!.metadata = metadata;
    expect((await run(f)).status).toBe(409);
    expect(f.calls).toEqual([]);
  });
  test.each(['replaced', 'mutated', 'missing'])('rejects a %s binding after handoff in the same region', async change => {
    const f = fixture();
    f.dependencies.handoff = async () => {
      if (change === 'mutated') (f.current!.metadata as any).sessionBoundAt = '2026-09-24T10:01:00.000Z';
      else f.current!.metadata = change === 'missing' ? {} : { sessionBoundAt: '2026-09-24T10:01:00.000Z' };
      return { response: Response.json(ack), body: ack };
    };
    expect((await run(f)).status).toBe(409);
  });
  test('rechecks expiry after the final owner lookup', async () => {
    const f = fixture();
    const expiresAt = new Date(Date.now() + 10).toISOString();
    f.dependencies.handoff = async () => ({ response: Response.json(ack), body: { ...ack, expiresAt } });
    let reads = 0;
    f.dependencies.getSession = async () => {
      if (++reads === 2) await new Promise(resolve => setTimeout(resolve, 20));
      return f.current;
    };
    expect((await run(f)).status).toBe(504);
  });
  test.each(['getSession', 'handoff'] as const)('bounds a stalled %s', async method => {
    const f = fixture();
    f.dependencies[method] = (() => new Promise(() => {})) as any;
    expect((await run(f, { expectedPodUid: 'pod-1' }, 10)).status).toBe(504);
  });
  test('regional transport sends service auth, allocation identity, and deadline', async () => {
    const oldFetch = globalThis.fetch;
    const calls: unknown[][] = [];
    try {
      globalThis.fetch = (async (...args: unknown[]) => { calls.push(args); return Response.json(ack); }) as typeof fetch;
      await handoffRegionalSession({ ...region, serviceAuthToken: 'regional-test' }, 'session-1', 'owner', 'pod-1', 'fallback-test');
      const [url, options] = calls[0] as [string, RequestInit];
      expect(url).toBe('http://pool.test/internal/session/session-1/handoff');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({ Authorization: 'Bearer regional-test', 'Content-Type': 'application/json' });
      expect(JSON.parse(String(options.body))).toEqual({ clientId: 'owner', expectedPodUid: 'pod-1' });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    } finally { globalThis.fetch = oldFetch; }
  });
});
