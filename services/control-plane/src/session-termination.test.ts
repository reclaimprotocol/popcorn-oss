import { describe, expect, test } from 'bun:test';
import { terminateRoutedSession } from './session-termination';

const boundAt = '2026-09-24T00:00:00.000Z';
function fixture() {
  const f = {
    current: { clientId: 'owner', status: 'active', region: 'region', metadata: { sessionBoundAt: boundAt } },
    ack: { success: true, sessionId: 'session-1', podUid: 'pod-1', boundAt, shutdownAcknowledged: true, allocationReleased: true } as any,
    deleted: false, calls: [] as any[], remote: async () => {},
  };
  const dependencies = {
    getSession: async () => ({ ...f.current }), resolveRegion: () => ({ name: 'region' } as any),
    terminate: async (...args: any[]) => { f.calls.push(args); await f.remote(); return { response: Response.json(f.ack), body: f.ack }; },
    endIfCurrent: async (_id: string, clientId: string, expectedBoundAt: string) => {
      if (f.current.clientId !== clientId || f.current.metadata.sessionBoundAt !== expectedBoundAt) return false;
      f.deleted = true; return true;
    },
  };
  return { f, dependencies };
}
const run = (h: ReturnType<typeof fixture>, body: unknown = { expectedPodUid: 'pod-1' }) => terminateRoutedSession('session-1', 'owner', body, h.dependencies);
describe('routed maintenance termination', () => {
  test('authenticates ownership and forwards host-bound allocation metadata', async () => {
    const h = fixture();
    expect((await run(h)).body).toEqual({ success: true, sessionId: 'session-1', podUid: 'pod-1', shutdownAcknowledged: true, allocationReleased: true });
    expect(h.f.calls[0].slice(1, 5)).toEqual(['session-1', 'owner', 'pod-1', boundAt]);
    expect(h.f.deleted).toBe(true);
  });
  test('rejects another owner or caller-supplied ownership', async () => {
    const h = fixture();
    h.f.current.clientId = 'other';
    expect((await run(h)).status).toBe(404);
    expect((await run(h, { expectedPodUid: 'pod-1', clientId: 'other' })).status).toBe(400);
    expect(h.f.calls).toHaveLength(0);
  });
  test.each(['old-server', 'uid', 'binding', 'shutdown', 'release'])('rejects %s acknowledgement without ending metadata', async change => {
    const h = fixture();
    if (change === 'old-server') h.f.ack = { success: true, deleted: true };
    if (change === 'uid') h.f.ack.podUid = 'replacement';
    if (change === 'binding') h.f.ack.boundAt = 'other';
    if (change === 'shutdown') h.f.ack.shutdownAcknowledged = false;
    if (change === 'release') h.f.ack.allocationReleased = false;
    expect((await run(h)).status).toBe(502);
    expect(h.f.deleted).toBe(false);
  });
  test('control-plane reallocation during remote deletion fails the final metadata fence', async () => {
    const h = fixture();
    h.f.remote = async () => { h.f.current.metadata.sessionBoundAt = '2026-09-24T01:00:00.000Z'; };
    expect((await run(h)).status).toBe(409);
    expect(h.f.deleted).toBe(false);
  });
  test('a late remote acknowledgement cannot end metadata after the deadline', async () => {
    const h = fixture();
    let finish!: () => void;
    h.f.remote = () => new Promise(resolve => { finish = resolve; });
    expect((await terminateRoutedSession('session-1', 'owner', { expectedPodUid: 'pod-1' }, h.dependencies, 5)).status).toBe(504);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.f.deleted).toBe(false);
  });
  test('synchronous work past the deadline cannot start remote deletion', async () => {
    const h = fixture();
    h.dependencies.getSession = async () => {
      const end = Date.now() + 15;
      while (Date.now() < end) { /* simulate a stalled event loop */ }
      return h.f.current;
    };
    expect((await terminateRoutedSession('session-1', 'owner', { expectedPodUid: 'pod-1' }, h.dependencies, 5)).status).toBe(504);
    expect(h.f.calls).toHaveLength(0);
  });
});
