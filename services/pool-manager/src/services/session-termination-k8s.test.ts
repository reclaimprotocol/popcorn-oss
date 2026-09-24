import { describe, expect, test } from 'bun:test';
import { shutdownCurrentAllocation } from './session-termination-k8s';
import { ViewerHandoffConflict } from '../viewer-handoff';

const allocation = { name: 'browser-1', namespace: 'browsers', sessionId: 'session-1', podUid: 'pod-1', boundAt: '2026-09-24T00:00:00.000Z' };
function fixture() {
  const annotations = { 'popcorn.dev/session-id': allocation.sessionId, 'popcorn.dev/session-bound-at': allocation.boundAt };
  const gs = { metadata: { uid: 'gs-1', resourceVersion: '42', annotations: { ...annotations } }, status: { state: 'Allocated' } } as any;
  const pod = { metadata: { uid: 'pod-1', annotations: { ...annotations }, ownerReferences: [{ uid: 'gs-1', name: 'browser-1', apiVersion: 'agones.dev/v1', kind: 'GameServer', controller: true }] } } as any;
  const calls: Array<{ path: string; options: RequestInit }> = [];
  const request = async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    return Response.json(options.method === 'DELETE' ? {} : path.includes('/pods/') ? pod : gs);
  };
  return { gs, pod, calls, request };
}

describe('allocation-fenced Kubernetes termination', () => {
  test('deletes only the verified GameServer with UID and resourceVersion preconditions', async () => {
    const f = fixture();
    await shutdownCurrentAllocation(allocation, new AbortController().signal, f.request);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]?.path).toBe('/apis/agones.dev/v1/namespaces/browsers/gameservers/browser-1');
    expect(JSON.parse(String(f.calls[2]?.options.body))).toEqual({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'gs-1', resourceVersion: '42' } });
    expect(f.calls.every(call => call.options.signal instanceof AbortSignal)).toBe(true);
  });

  test.each(['podUid', 'ownerUid', 'ownerName', 'ownerKind', 'controller', 'state', 'session', 'boundAt', 'resourceVersion', 'podBinding'])('rejects %s before any DELETE', async change => {
    const f = fixture();
    if (change === 'podUid') f.pod.metadata.uid = 'replacement';
    if (change === 'ownerUid') f.pod.metadata.ownerReferences[0].uid = 'other-gs';
    if (change === 'ownerName') f.pod.metadata.ownerReferences[0].name = 'other-name';
    if (change === 'ownerKind') f.pod.metadata.ownerReferences[0].kind = 'Deployment';
    if (change === 'controller') f.pod.metadata.ownerReferences[0].controller = false;
    if (change === 'state') f.gs.status.state = 'Ready';
    if (change === 'session') f.gs.metadata.annotations['popcorn.dev/session-id'] = 'other-session';
    if (change === 'boundAt') f.gs.metadata.annotations['popcorn.dev/session-bound-at'] = 'other-binding';
    if (change === 'resourceVersion') delete f.gs.metadata.resourceVersion;
    if (change === 'podBinding') f.pod.metadata.annotations['popcorn.dev/session-id'] = 'other-session';
    await expect(shutdownCurrentAllocation(allocation, new AbortController().signal, f.request)).rejects.toBeInstanceOf(ViewerHandoffConflict);
    expect(f.calls.some(call => call.options.method === 'DELETE')).toBe(false);
  });

  test.each(['recreated', 'rebound'])('a %s GameServer cannot satisfy the prior delete preconditions', async change => {
    const f = fixture();
    let deleted = false;
    const request = async (path: string, options: RequestInit) => {
      if (options.method !== 'DELETE') return f.request(path, options);
      const expected = JSON.parse(String(options.body)).preconditions;
      const current = change === 'recreated' ? { uid: 'new-gs', resourceVersion: '43' } : { uid: 'gs-1', resourceVersion: '43' };
      if (expected.uid !== current.uid || expected.resourceVersion !== current.resourceVersion) return new Response('', { status: 409 });
      deleted = true;
      return Response.json({});
    };
    await expect(shutdownCurrentAllocation(allocation, new AbortController().signal, request)).rejects.toBeInstanceOf(ViewerHandoffConflict);
    expect(deleted).toBe(false);
  });
});
