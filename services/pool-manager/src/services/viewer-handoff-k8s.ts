import { isIP } from 'node:net';
import { SESSION_BOUND_AT_ANNOTATION, SESSION_ID_ANNOTATION } from '../session-metadata';
import { VIEWER_HANDOFF_ANNOTATION, VIEWER_HANDOFF_STATUS_PATH, ViewerHandoffConflict, type HandoffAllocation } from '../viewer-handoff';

type K8sFetch = (path: string, options: RequestInit) => Promise<Response>;

/** Authenticated Kubernetes control is the only writer; runtime status is read-only. */
export async function controlViewerHandoff(
  allocation: HandoffAllocation,
  signal: AbortSignal,
  request: K8sFetch,
  mode: 'request' | 'inspect' | 'confirm' = 'request',
): Promise<string> {
  const namespace = encodeURIComponent(allocation.namespace);
  const name = encodeURIComponent(allocation.name);
  const gameServerPath = `/apis/agones.dev/v1/namespaces/${namespace}/gameservers/${name}`;
  const [podResponse, gsResponse] = await Promise.all([
    request(`/api/v1/namespaces/${namespace}/pods/${name}`, { method: 'GET', signal }),
    request(gameServerPath, { method: 'GET', signal }),
  ]);
  if (podResponse.status === 404 || gsResponse.status === 404) throw new ViewerHandoffConflict();
  if (!podResponse.ok || !gsResponse.ok) throw new Error('Cannot read handoff allocation');
  const [pod, gameServer] = await Promise.all([podResponse.json(), gsResponse.json()]) as any[];
  const annotations = gameServer.metadata?.annotations;
  const ip = pod.status?.podIP;
  const prior = annotations?.[VIEWER_HANDOFF_ANNOTATION];
  if (pod.metadata?.uid !== allocation.podUid || pod.metadata?.deletionTimestamp
    || gameServer.metadata?.deletionTimestamp || !gameServer.metadata?.uid || !gameServer.metadata?.resourceVersion
    || gameServer.status?.state !== 'Allocated'
    || annotations?.[SESSION_ID_ANNOTATION] !== allocation.sessionId
    || annotations?.[SESSION_BOUND_AT_ANNOTATION] !== allocation.boundAt
    || pod.metadata?.annotations?.[SESSION_ID_ANNOTATION] !== allocation.sessionId
    || pod.metadata?.annotations?.[SESSION_BOUND_AT_ANNOTATION] !== allocation.boundAt
    || typeof ip !== 'string' || !isIP(ip)
    || (prior !== undefined && prior !== allocation.podUid)) {
    throw new ViewerHandoffConflict();
  }
  if (mode === 'confirm' && prior !== allocation.podUid) throw new ViewerHandoffConflict();
  if (mode === 'request' && prior !== allocation.podUid) {
    const escaped = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
    const response = await request(gameServerPath, {
      method: 'PATCH', signal, headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([
        { op: 'test', path: '/metadata/uid', value: gameServer.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: gameServer.metadata.resourceVersion },
        { op: 'test', path: '/status/state', value: 'Allocated' },
        { op: 'test', path: `/metadata/annotations/${escaped(SESSION_ID_ANNOTATION)}`, value: allocation.sessionId },
        { op: 'test', path: `/metadata/annotations/${escaped(SESSION_BOUND_AT_ANNOTATION)}`, value: allocation.boundAt },
        { op: 'add', path: `/metadata/annotations/${escaped(VIEWER_HANDOFF_ANNOTATION)}`, value: allocation.podUid },
      ]),
    });
    if ([404, 409, 422].includes(response.status)) throw new ViewerHandoffConflict();
    if (!response.ok) throw new Error('Cannot persist viewer handoff');
  }
  return `http://${isIP(ip) === 6 ? `[${ip}]` : ip}:6080${VIEWER_HANDOFF_STATUS_PATH}`;
}
