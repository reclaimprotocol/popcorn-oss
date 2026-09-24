import type { Pod } from './types';
import { storedSessionAccess } from './session-access';

export const VIEWER_HANDOFF_ANNOTATION = 'popcorn.dev/viewer-handoff';
export const VIEWER_HANDOFF_STATUS_PATH = '/_popcorn/viewer-handoff-status';
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;

export class ViewerHandoffConflict extends Error {
  constructor() { super('Session allocation cannot be handed off'); }
}

export interface HandoffAllocation {
  sessionId: string;
  podUid: string;
  name: string;
  namespace: string;
  boundAt: string;
}

export interface ViewerHandoffDependencies {
  namespace: string;
  getSession(sessionId: string): Promise<Pod | null>;
  inspectHandoff(allocation: HandoffAllocation, signal: AbortSignal): Promise<string>;
  requestHandoff(allocation: HandoffAllocation, signal: AbortSignal): Promise<string>;
  confirmHandoff(allocation: HandoffAllocation, signal: AbortSignal): Promise<string>;
  readStatus(url: string, signal: AbortSignal): Promise<unknown>;
}

function activeSession(session: Pod, clientId: string, expectedPodUid: string): boolean {
  return session.clientId === clientId && session.podUid === expectedPodUid
    && Boolean(session.name && session.boundAt && Number.isFinite(Date.parse(session.boundAt)))
    && (!session.expiresAt || (Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > Date.now()))
    && storedSessionAccess(session).cdpScope === 'restricted';
}

function supported(value: unknown, allocation: HandoffAllocation): value is {
  version: 1; state: 'active' | 'revoking' | 'revoked'; sessionId: string; podUid: string; runtimeInstanceId: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return status.version === 1 && ['active', 'revoking', 'revoked'].includes(String(status.state))
    && status.sessionId === allocation.sessionId && status.podUid === allocation.podUid
    && typeof status.runtimeInstanceId === 'string' && NONCE_PATTERN.test(status.runtimeInstanceId);
}

function acknowledged(value: unknown, allocation: HandoffAllocation) {
  return supported(value, allocation) && value.state === 'revoked' ? value : null;
}

/** A timeout does not undo a persisted request. Retry the same allocation to confirm it. */
export async function handoffSession(
  sessionId: string,
  body: unknown,
  dependencies: ViewerHandoffDependencies,
  timing: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || !body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { success: false, error: 'Invalid handoff request' } };
  }
  const { expectedPodUid, clientId } = body as Record<string, unknown>;
  if (typeof expectedPodUid !== 'string' || !UID_PATTERN.test(expectedPodUid)
    || typeof clientId !== 'string' || !clientId || clientId.length > 256
    || Object.keys(body).some(key => key !== 'expectedPodUid' && key !== 'clientId')) {
    return { status: 400, body: { success: false, error: 'Invalid handoff request' } };
  }

  const timeoutMs = timing.timeoutMs ?? 10_000;
  const pollMs = timing.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (Date.now() >= deadline) controller.abort();
    signal.throwIfAborted();
    let stop: () => void = () => {};
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          stop = () => reject(new Error('Handoff deadline exceeded'));
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
        }),
      ]);
    } finally { signal.removeEventListener('abort', stop); }
  };

  try {
    const session = await bounded(() => dependencies.getSession(sessionId));
    if (!session || session.clientId !== clientId) {
      return { status: 404, body: { success: false, error: 'Session not found' } };
    }
    if (!activeSession(session, clientId, expectedPodUid)) throw new ViewerHandoffConflict();
    const allocation: HandoffAllocation = {
      sessionId, podUid: expectedPodUid, name: session.name,
      namespace: session.namespace || dependencies.namespace, boundAt: session.boundAt!,
    };
    const stillOwned = async () => {
      const current = await bounded(() => dependencies.getSession(sessionId));
      if (!current || !activeSession(current, clientId, expectedPodUid)
        || current.name !== allocation.name || current.boundAt !== allocation.boundAt
        || (current.namespace || dependencies.namespace) !== allocation.namespace) {
        throw new ViewerHandoffConflict();
      }
      return current;
    };
    const runtimeUrl = await bounded(() => dependencies.inspectHandoff(allocation, signal));
    const preflight = await bounded(() => dependencies.readStatus(runtimeUrl, signal));
    if (!supported(preflight, allocation)) throw new ViewerHandoffConflict();
    await stillOwned();
    const requestedUrl = await bounded(() => dependencies.requestHandoff(allocation, signal));
    if (requestedUrl !== runtimeUrl) throw new ViewerHandoffConflict();
    while (Date.now() < deadline) {
      let status: unknown;
      try { status = await bounded(() => dependencies.readStatus(runtimeUrl, signal)); }
      catch { if (signal.aborted) throw new Error('Handoff deadline exceeded'); }
      const ack = acknowledged(status, allocation);
      if (ack) {
        await stillOwned();
        const confirmedUrl = await bounded(() => dependencies.confirmHandoff(allocation, signal));
        if (confirmedUrl !== runtimeUrl) throw new ViewerHandoffConflict();
        // A new process must independently revoke its channels. Never reuse an old acknowledgement.
        const fresh = acknowledged(await bounded(() => dependencies.readStatus(runtimeUrl, signal)), allocation);
        if (fresh && fresh.runtimeInstanceId === ack.runtimeInstanceId) {
          const current = await stillOwned();
          if (signal.aborted || Date.now() >= deadline) throw new Error('Handoff deadline exceeded');
          return { status: 200, body: {
            success: true, sessionId, podUid: expectedPodUid, viewerAccess: 'revoked',
            runtimeInstanceId: fresh.runtimeInstanceId,
            ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}),
          } };
        }
      }
      await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now())))));
    }
    return { status: 504, body: { success: false, error: 'Viewer handoff is unconfirmed' } };
  } catch (error) {
    if (error instanceof ViewerHandoffConflict) {
      return { status: 409, body: { success: false, error: error.message } };
    }
    return { status: signal.aborted || Date.now() >= deadline ? 504 : 502,
      body: { success: false, error: 'Viewer handoff is unconfirmed' } };
  } finally { clearTimeout(timer); }
}

export async function readViewerHandoffStatus(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, cache: 'no-store', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Runtime status unavailable');
  return readBoundedJson(response.body, 4096);
}

export async function readViewerHandoffRequest(request: Request): Promise<{ body?: unknown; status?: 400 | 413 }> {
  if (!request.body) return { status: 400 };
  try {
    return { body: await readBoundedJson(request.body, 1024) };
  } catch (error) {
    return { status: error instanceof RangeError ? 413 : 400 };
  }
}

async function readBoundedJson(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<unknown> {
  const reader = body.getReader();
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new RangeError('Invalid bounded JSON body');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => undefined); }
}
