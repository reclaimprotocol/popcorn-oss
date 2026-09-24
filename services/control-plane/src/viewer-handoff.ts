import type { RegionConfig } from './config';

interface RoutedHandoffDependencies {
  getSession(id: string): Promise<{ clientId: string; status: string; region?: string | null; clusterName?: string | null } | null>;
  resolveRegion(session: { region?: string | null; clusterName?: string | null }): RegionConfig | null;
  handoff(region: RegionConfig, sessionId: string, clientId: string, podUid: string, signal: AbortSignal): Promise<{ response: Response; body: unknown }>;
}

/** This route accepts credentials, not session URLs. The authenticated owner supplies the allocation UID. */
export async function handoffRoutedSession(
  sessionId: string, clientId: string, body: unknown, dependencies: RoutedHandoffDependencies,
  timeoutMs = 15_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'expectedPodUid')) {
    return { status: 400, body: { success: false, error: 'Invalid handoff request' } };
  }
  const expectedPodUid = (body as Record<string, unknown>).expectedPodUid;
  if (typeof expectedPodUid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(expectedPodUid)) {
    return { status: 400, body: { success: false, error: 'Invalid handoff request' } };
  }
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (Date.now() >= deadline) controller.abort();
    signal.throwIfAborted();
    let stop: () => void = () => {};
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        stop = () => reject(new Error('Handoff deadline exceeded'));
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      })]);
    } finally { signal.removeEventListener('abort', stop); }
  };
  try {
    const session = await bounded(() => dependencies.getSession(sessionId));
    if (!session || session.clientId !== clientId) {
      return { status: 404, body: { success: false, error: 'Session not found' } };
    }
    if (session.status !== 'active') return { status: 409, body: { success: false, error: 'Session is not active' } };
    const region = dependencies.resolveRegion(session);
    if (!region) return { status: 409, body: { success: false, error: 'Session region is not configured' } };
    const remote = await bounded(() => dependencies.handoff(region, sessionId, clientId, expectedPodUid, signal));
    if (!remote.response.ok) {
      const status = [400, 404, 409, 504].includes(remote.response.status) ? remote.response.status : 502;
      return { status, body: { success: false, error: 'Viewer handoff is unconfirmed' } };
    }
    const ack = remote.body as Record<string, unknown> | null;
    if (!ack || typeof ack !== 'object' || Array.isArray(ack) || ack.success !== true
      || ack.sessionId !== sessionId || ack.podUid !== expectedPodUid || ack.viewerAccess !== 'revoked'
      || typeof ack.runtimeInstanceId !== 'string' || !/^[a-f0-9]{32}$/.test(ack.runtimeInstanceId)
      || (ack.expiresAt !== undefined && (typeof ack.expiresAt !== 'string' || !Number.isFinite(Date.parse(ack.expiresAt))
        || Date.parse(ack.expiresAt) <= Date.now()))) {
      return { status: 502, body: { success: false, error: 'Viewer handoff is unconfirmed' } };
    }
    const current = await bounded(() => dependencies.getSession(sessionId));
    if (!current || current.clientId !== clientId || current.status !== 'active'
      || current.region !== session.region || current.clusterName !== session.clusterName) {
      return { status: 409, body: { success: false, error: 'Session changed during handoff' } };
    }
    if (signal.aborted || Date.now() >= deadline
      || (typeof ack.expiresAt === 'string' && Date.parse(ack.expiresAt) <= Date.now())) {
      return { status: 504, body: { success: false, error: 'Viewer handoff is unconfirmed' } };
    }
    return { status: 200, body: {
      success: true, sessionId, podUid: expectedPodUid, viewerAccess: 'revoked', runtimeInstanceId: ack.runtimeInstanceId,
      ...(ack.expiresAt ? { expiresAt: ack.expiresAt } : {}),
    } };
  } catch {
    return { status: signal.aborted || Date.now() >= deadline ? 504 : 502,
      body: { success: false, error: 'Viewer handoff is unconfirmed' } };
  } finally { clearTimeout(timer); }
}
