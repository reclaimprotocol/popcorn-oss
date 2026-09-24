import type { Pod } from './types';
import { ViewerHandoffConflict, type HandoffAllocation } from './viewer-handoff';

interface TerminationDependencies {
  namespace: string;
  getSession(id: string): Promise<Pod | null>;
  shutdown(allocation: HandoffAllocation, signal: AbortSignal): Promise<void>;
  deleteIfCurrent(id: string, session: Pod): Promise<boolean>;
}

export async function terminateCurrentSession(sessionId: string, body: unknown, dependencies: TerminationDependencies, timeoutMs = 7_000) {
  const invalid = { status: 400, body: { success: false, error: 'Invalid termination request' } };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || !body || typeof body !== 'object' || Array.isArray(body)) return invalid;
  const { expectedPodUid, expectedBoundAt, clientId } = body as Record<string, unknown>;
  if (Object.keys(body).some(key => !['expectedPodUid', 'expectedBoundAt', 'clientId'].includes(key))
    || typeof expectedPodUid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(expectedPodUid)
    || typeof expectedBoundAt !== 'string' || !Number.isFinite(Date.parse(expectedBoundAt))
    || typeof clientId !== 'string' || !clientId || clientId.length > 256) return invalid;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const assertWithinDeadline = () => {
    if (Date.now() >= deadline) controller.abort();
    controller.signal.throwIfAborted();
  };
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    const stop = () => { timedOut = true; reject(new Error('Termination deadline exceeded')); };
    controller.signal.addEventListener('abort', stop, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const work = async () => {
    const session = await dependencies.getSession(sessionId);
    assertWithinDeadline();
    if (!session || session.clientId !== clientId) return { status: 404, body: { success: false, error: 'Session not found' } };
    if (session.podUid !== expectedPodUid || !session.name || session.boundAt !== expectedBoundAt) throw new ViewerHandoffConflict();
    const allocation = { sessionId, podUid: expectedPodUid, name: session.name, namespace: session.namespace || dependencies.namespace, boundAt: session.boundAt };
    await dependencies.shutdown(allocation, controller.signal);
    assertWithinDeadline();
    if (!await dependencies.deleteIfCurrent(sessionId, session)) throw new ViewerHandoffConflict();
    assertWithinDeadline();
    return { status: 200, body: {
      success: true, sessionId, podUid: expectedPodUid, boundAt: session.boundAt,
      shutdownAcknowledged: true, allocationReleased: true,
    } };
  };
  try { return await Promise.race([work(), timeout]); }
  catch (error) {
    return { status: timedOut ? 504 : error instanceof ViewerHandoffConflict ? 409 : 502,
      body: { success: false, error: 'Allocation termination is unconfirmed' } };
  } finally { clearTimeout(timer); }
}
