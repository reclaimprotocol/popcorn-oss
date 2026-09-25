import { SESSION_BOUND_AT_ANNOTATION, SESSION_ID_ANNOTATION } from '../session-metadata';
import { ViewerHandoffConflict, type HandoffAllocation } from '../viewer-handoff';

type K8sFetch = (path: string, options: RequestInit) => Promise<Response>;

/** Delete the allocated GameServer, never a later object under the same name. */
export async function shutdownCurrentAllocation(allocation: HandoffAllocation, signal: AbortSignal, request: K8sFetch): Promise<void> {
  const namespace = encodeURIComponent(allocation.namespace);
  const name = encodeURIComponent(allocation.name);
  const gsPath = `/apis/agones.dev/v1/namespaces/${namespace}/gameservers/${name}`;
  const [podResponse, gsResponse] = await Promise.all([
    request(`/api/v1/namespaces/${namespace}/pods/${name}`, { method: 'GET', signal }),
    request(gsPath, { method: 'GET', signal }),
  ]);
  if ([podResponse.status, gsResponse.status].some(status => status === 404)) throw new ViewerHandoffConflict();
  if (!podResponse.ok || !gsResponse.ok) throw new Error('Allocation inspection failed');
  const [pod, gs] = await Promise.all([podResponse.json(), gsResponse.json()]) as any[];
  const metadata = gs.metadata;
  const ownsPod = Array.isArray(pod.metadata?.ownerReferences) && pod.metadata.ownerReferences.some((owner: any) =>
    owner.controller === true && owner.kind === 'GameServer' && owner.apiVersion === 'agones.dev/v1'
      && owner.name === allocation.name && owner.uid === metadata?.uid);
  if (pod.metadata?.uid !== allocation.podUid || pod.metadata?.deletionTimestamp || !ownsPod
    || !metadata?.uid || !metadata?.resourceVersion || metadata.deletionTimestamp || gs.status?.state !== 'Allocated'
    || metadata.annotations?.[SESSION_ID_ANNOTATION] !== allocation.sessionId
    || metadata.annotations?.[SESSION_BOUND_AT_ANNOTATION] !== allocation.boundAt
    || pod.metadata.annotations?.[SESSION_ID_ANNOTATION] !== allocation.sessionId
    || pod.metadata.annotations?.[SESSION_BOUND_AT_ANNOTATION] !== allocation.boundAt) throw new ViewerHandoffConflict();
  signal.throwIfAborted();
  const response = await request(gsPath, {
    method: 'DELETE', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: metadata.uid, resourceVersion: metadata.resourceVersion } }),
  });
  if ([404, 409, 422].includes(response.status)) throw new ViewerHandoffConflict();
  if (![200, 202].includes(response.status)) throw new Error('Allocation shutdown is unconfirmed');
}
