import type { RegionConfig } from './config';

interface Session { clientId: string; status: string; region?: string | null; clusterName?: string | null; metadata: unknown }
interface Dependencies {
  getSession(id: string): Promise<Session | null>;
  resolveRegion(session: Session): RegionConfig | null;
  terminate(region: RegionConfig, id: string, clientId: string, podUid: string, boundAt: string, signal: AbortSignal): Promise<{ response: Response; body: unknown }>;
  endIfCurrent(id: string, clientId: string, boundAt: string): Promise<boolean>;
}

export async function terminateRoutedSession(sessionId: string, clientId: string, body: unknown, dependencies: Dependencies, timeoutMs = 9_000) {
  const invalid = { status: 400, body: { success: false, error: 'Invalid termination request' } };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'expectedPodUid')) return invalid;
  const { expectedPodUid } = body as Record<string, unknown>;
  if (typeof expectedPodUid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(expectedPodUid)) return invalid;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const assertWithinDeadline = () => {
    if (Date.now() >= deadline) controller.abort();
    controller.signal.throwIfAborted();
  };
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => { timedOut = true; reject(new Error('Termination deadline exceeded')); }, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const work = async () => {
    const session = await dependencies.getSession(sessionId);
    assertWithinDeadline();
    if (!session || session.clientId !== clientId) return { status: 404, body: { success: false, error: 'Session not found' } };
    const boundAt = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>).sessionBoundAt : undefined;
    const region = dependencies.resolveRegion(session);
    if (session.status !== 'active' || !region || typeof boundAt !== 'string' || !Number.isFinite(Date.parse(boundAt))) {
      return { status: 409, body: { success: false, error: 'Session allocation is not current' } };
    }
    const remote = await dependencies.terminate(region, sessionId, clientId, expectedPodUid, boundAt, controller.signal);
    assertWithinDeadline();
    if (!remote.response.ok) return { status: [400, 404, 409, 504].includes(remote.response.status) ? remote.response.status : 502,
      body: { success: false, error: 'Allocation termination is unconfirmed' } };
    const ack = remote.body as Record<string, unknown> | null;
    if (!ack || typeof ack !== 'object' || Array.isArray(ack) || ack.success !== true || ack.sessionId !== sessionId
      || ack.podUid !== expectedPodUid || ack.boundAt !== boundAt || ack.shutdownAcknowledged !== true || ack.allocationReleased !== true) {
      return { status: 502, body: { success: false, error: 'Allocation termination is unconfirmed' } };
    }
    if (!await dependencies.endIfCurrent(sessionId, clientId, boundAt)) {
      return { status: 409, body: { success: false, error: 'Session changed during termination' } };
    }
    assertWithinDeadline();
    return { status: 200, body: { success: true, sessionId, podUid: expectedPodUid, shutdownAcknowledged: true, allocationReleased: true } };
  };
  try { return await Promise.race([work(), timeout]); }
  catch { return { status: timedOut ? 504 : 502, body: { success: false, error: 'Allocation termination is unconfirmed' } }; }
  finally { clearTimeout(timer); }
}
