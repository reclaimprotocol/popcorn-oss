import { describe, expect, test } from 'bun:test';
import { controlViewerHandoff } from './viewer-handoff-k8s';
import { VIEWER_HANDOFF_ANNOTATION, ViewerHandoffConflict, type HandoffAllocation } from '../viewer-handoff';

const allocation: HandoffAllocation = { name: 'browser-1', namespace: 'browsers', sessionId: 'session-1', podUid: 'pod-1', boundAt: '2026-09-24T00:00:00.000Z' };
function fixture() {
  const annotations = { 'popcorn.dev/session-id': allocation.sessionId, 'popcorn.dev/session-bound-at': allocation.boundAt } as Record<string, string>;
  const pod = { metadata: { uid: allocation.podUid, annotations: { ...annotations },
    ownerReferences: [{ controller: true, kind: 'GameServer', apiVersion: 'agones.dev/v1', name: allocation.name, uid: 'gs-uid' }],
  } as any, status: { podIP: '10.0.0.1' } };
  const gs = { metadata: { uid: 'gs-uid', resourceVersion: '42', annotations } as any, status: { state: 'Allocated' } };
  const requests: { path: string; options: RequestInit }[] = [];
  const request = async (path: string, options: RequestInit) => {
    requests.push({ path, options });
    if (options.method === 'PATCH') return Response.json({});
    return Response.json(path.includes('/pods/') ? pod : gs);
  };
  return { pod, gs, requests, request };
}
const run = (f: ReturnType<typeof fixture>, mode: 'request' | 'inspect' | 'confirm' = 'request') => controlViewerHandoff(allocation, new AbortController().signal, f.request, mode);

describe('Kubernetes handoff control', () => {
  test('uses conditional tests before adding the one-way annotation', async () => {
    const f = fixture();
    expect(await run(f)).toBe('http://10.0.0.1:6080/_popcorn/viewer-handoff-status');
    const patch = f.requests[2]!;
    expect(patch.options.headers).toEqual({ 'Content-Type': 'application/json-patch+json' });
    expect(JSON.parse(String(patch.options.body))).toEqual([
      { op: 'test', path: '/metadata/uid', value: 'gs-uid' },
      { op: 'test', path: '/metadata/resourceVersion', value: '42' },
      { op: 'test', path: '/status/state', value: 'Allocated' },
      { op: 'test', path: '/metadata/annotations/popcorn.dev~1session-id', value: allocation.sessionId },
      { op: 'test', path: '/metadata/annotations/popcorn.dev~1session-bound-at', value: allocation.boundAt },
      { op: 'add', path: '/metadata/annotations/popcorn.dev~1viewer-handoff', value: allocation.podUid },
    ]);
    expect(f.requests.every(r => r.options.signal instanceof AbortSignal)).toBe(true);
  });
  test('preflight and idempotent retries do not write Kubernetes', async () => {
    const f = fixture();
    await run(f, 'inspect');
    f.gs.metadata.annotations[VIEWER_HANDOFF_ANNOTATION] = allocation.podUid;
    await run(f);
    await run(f, 'confirm');
    expect(f.requests.some(r => r.options.method === 'PATCH')).toBe(false);
  });
  test.each(['podUid', 'podDeleted', 'gsDeleted', 'gsUid', 'resourceVersion', 'state', 'gsSession', 'gsBoundAt', 'podSession', 'podBoundAt', 'otherHandoff', 'ip'])('fails closed on %s mismatch', async change => {
    const f = fixture();
    if (change === 'podUid') f.pod.metadata.uid = 'new-pod';
    if (change === 'podDeleted') f.pod.metadata.deletionTimestamp = 'now';
    if (change === 'gsDeleted') f.gs.metadata.deletionTimestamp = 'now';
    if (change === 'gsUid') delete f.gs.metadata.uid;
    if (change === 'resourceVersion') delete f.gs.metadata.resourceVersion;
    if (change === 'state') f.gs.status.state = 'Shutdown';
    if (change === 'gsSession') f.gs.metadata.annotations['popcorn.dev/session-id'] = 'other';
    if (change === 'gsBoundAt') f.gs.metadata.annotations['popcorn.dev/session-bound-at'] = 'other';
    if (change === 'podSession') f.pod.metadata.annotations['popcorn.dev/session-id'] = 'other';
    if (change === 'podBoundAt') f.pod.metadata.annotations['popcorn.dev/session-bound-at'] = 'other';
    if (change === 'otherHandoff') f.gs.metadata.annotations[VIEWER_HANDOFF_ANNOTATION] = 'other';
    if (change === 'ip') f.pod.status.podIP = 'attacker.example';
    await expect(run(f)).rejects.toBeInstanceOf(ViewerHandoffConflict);
    expect(f.requests).toHaveLength(2);
  });
  test('confirmation requires the persisted handoff annotation', async () => {
    await expect(run(fixture(), 'confirm')).rejects.toBeInstanceOf(ViewerHandoffConflict);
  });
  test.each(['request', 'inspect', 'confirm'] as const)('requires a current controller owner during %s', async mode => {
    for (const change of ['missing', 'notArray', 'uid', 'name', 'kind', 'apiVersion', 'controller']) {
      const f = fixture();
      f.gs.metadata.annotations[VIEWER_HANDOFF_ANNOTATION] = allocation.podUid;
      if (change === 'missing') delete f.pod.metadata.ownerReferences;
      else if (change === 'notArray') f.pod.metadata.ownerReferences = {};
      else f.pod.metadata.ownerReferences[0][change] = change === 'controller' ? false : 'unrelated';
      await expect(run(f, mode)).rejects.toBeInstanceOf(ViewerHandoffConflict);
      expect(f.requests).toHaveLength(2);
    }
  });
  test.each([404, 409, 422])('does not treat rejected patch %d as acknowledgement', async status => {
    const f = fixture();
    const read = f.request;
    f.request = async (path, options) => options.method === 'PATCH' ? new Response('', { status }) : read(path, options);
    await expect(run(f)).rejects.toBeInstanceOf(ViewerHandoffConflict);
  });
  test('supports a verified IPv6 PodIP', async () => {
    const f = fixture();
    f.pod.status.podIP = '2001:db8::1';
    expect(await run(f)).toBe('http://[2001:db8::1]:6080/_popcorn/viewer-handoff-status');
  });
});
