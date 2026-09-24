import { describe, expect, test } from 'bun:test';
import { terminateCurrentSession } from './session-termination';
import type { Pod } from './types';

const boundAt = '2026-09-24T00:00:00.000Z';
const body = { clientId: 'owner', expectedPodUid: 'pod-1', expectedBoundAt: boundAt };
function fixture() {
  const session: Pod = { name: 'browser-1', namespace: 'default', url: 'http://10.0.0.1:9222', clientId: 'owner', podUid: 'pod-1', boundAt };
  const f = { current: session as Pod | null, calls: [] as string[], shutdown: async () => {} };
  const dependencies = {
    namespace: 'default', getSession: async () => f.current ? { ...f.current } : null,
    shutdown: async () => { f.calls.push('shutdown'); await f.shutdown(); },
    deleteIfCurrent: async (_id: string, expected: Pod) => {
      f.calls.push('conditional-delete');
      if (JSON.stringify(f.current) !== JSON.stringify(expected)) return false;
      f.current = null;
      return true;
    },
  };
  return { f, dependencies };
}
describe('regional maintenance termination', () => {
  test('acknowledges only fenced shutdown and matching metadata removal', async () => {
    const { f, dependencies } = fixture();
    expect(await terminateCurrentSession('session-1', body, dependencies)).toEqual({ status: 200, body: {
      success: true, sessionId: 'session-1', podUid: 'pod-1', boundAt, shutdownAcknowledged: true, allocationReleased: true,
    } });
    expect(f.calls).toEqual(['shutdown', 'conditional-delete']);
  });
  test.each(['owner', 'uid', 'binding', 'missing'])('rejects initial %s mismatch without shutdown', async change => {
    const { f, dependencies } = fixture();
    if (change === 'owner') f.current!.clientId = 'other';
    if (change === 'uid') f.current!.podUid = 'replacement';
    if (change === 'binding') f.current!.boundAt = '2026-09-24T01:00:00.000Z';
    if (change === 'missing') f.current = null;
    expect((await terminateCurrentSession('session-1', body, dependencies)).status).toBe(change === 'owner' || change === 'missing' ? 404 : 409);
    expect(f.calls).toEqual([]);
  });
  test('reallocated metadata during shutdown is never removed or acknowledged', async () => {
    const { f, dependencies } = fixture();
    f.shutdown = async () => { f.current = { ...f.current!, podUid: 'replacement', boundAt: '2026-09-24T01:00:00.000Z' }; };
    expect((await terminateCurrentSession('session-1', body, dependencies)).status).toBe(409);
    expect(f.current?.podUid).toBe('replacement');
  });
  test('late shutdown acknowledgement after timeout cannot remove metadata', async () => {
    const { f, dependencies } = fixture();
    let finish!: () => void;
    f.shutdown = () => new Promise(resolve => { finish = resolve; });
    expect((await terminateCurrentSession('session-1', body, dependencies, 5)).status).toBe(504);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls).toEqual(['shutdown']);
    expect(f.current).not.toBeNull();
  });
  test('synchronous work past the deadline cannot start shutdown', async () => {
    const { f, dependencies } = fixture();
    dependencies.getSession = async () => {
      const end = Date.now() + 15;
      while (Date.now() < end) { /* simulate a stalled event loop */ }
      return f.current;
    };
    expect((await terminateCurrentSession('session-1', body, dependencies, 5)).status).toBe(504);
    expect(f.calls).toEqual([]);
  });
});
