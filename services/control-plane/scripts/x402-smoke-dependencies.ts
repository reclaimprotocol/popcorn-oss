const port = Number(process.env.X402_SMOKE_DEPENDENCIES_PORT || '4402');
const gateway = process.env.X402_SMOKE_GATEWAY
  || 'https://popcorn-gateway-gcp-us-central1-x402.reclaimprotocol.org';
const serviceToken = process.env.X402_SMOKE_SERVICE_TOKEN || 'x402-smoke-service-token';

type RegionalSession = {
  sessionId: string;
  expiresAt: string;
  publicAccessExpiresAt: string;
  nextExtensionSettlement: number;
};

const sessions = new Map<string, RegionalSession>();
let settlementNumber = 0;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function sessionResponse(session: RegionalSession) {
  const restrictedToken = `restricted-stable-${session.sessionId}`;
  const automationToken = `automation-stable-${session.sessionId}`;
  return {
    success: true,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    publicAccessExpiresAt: session.publicAccessExpiresAt,
    url: `${gateway}/vnc/${session.sessionId}/${restrictedToken}/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000`,
    cdpUrl: `${gateway.replace(/^https:/, 'wss:')}/cdp-agent/${session.sessionId}/${automationToken}/`,
    apiUrl: `${gateway}/api/${session.sessionId}/not-public/`,
    browserPodId: `smoke-browser-${session.sessionId}`,
  };
}

function authorized(request: Request): boolean {
  return request.headers.get('Authorization') === `Bearer ${serviceToken}`;
}

function payerFromRequest(body: any): string {
  return body?.paymentPayload?.payload?.authorization?.from
    || '0x2222222222222222222222222222222222222222';
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/facilitator/supported' && request.method === 'GET') {
      return json({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
        extensions: [],
        signers: {},
      });
    }
    if (url.pathname === '/facilitator/verify' && request.method === 'POST') {
      const body = await request.json();
      return json({ isValid: true, payer: payerFromRequest(body) });
    }
    if (url.pathname === '/facilitator/settle' && request.method === 'POST') {
      const body = await request.json();
      settlementNumber += 1;
      return json({
        success: true,
        payer: payerFromRequest(body),
        transaction: `0x${settlementNumber.toString(16).padStart(64, '0')}`,
        network: 'eip155:84532',
      });
    }

    if (!url.pathname.startsWith('/internal/') || !authorized(request)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    if (url.pathname === '/internal/sessions' && request.method === 'POST') {
      const body = await request.json() as Record<string, unknown>;
      const sessionId = String(body.sessionId || '');
      const expiresAt = String(body.expiresAt || '');
      if (!sessionId || !Number.isFinite(Date.parse(expiresAt))) {
        return json({ error: 'Invalid session allocation' }, 400);
      }
      const session = {
        sessionId,
        expiresAt,
        publicAccessExpiresAt: expiresAt,
        // Creation settles after allocation; the first TTL extension must not
        // occur until the following facilitator settlement.
        nextExtensionSettlement: settlementNumber + 2,
      };
      sessions.set(sessionId, session);
      return json(sessionResponse(session));
    }

    const ttlMatch = url.pathname.match(/^\/internal\/session\/([^/]+)\/ttl$/);
    if (ttlMatch && request.method === 'PATCH') {
      const sessionId = decodeURIComponent(ttlMatch[1]!);
      const session = sessions.get(sessionId);
      if (!session) return json({ error: 'Session not found' }, 404);
      const body = await request.json() as Record<string, unknown>;
      const expiresAt = String(body.expiresAt || '');
      if (!Number.isFinite(Date.parse(expiresAt))) return json({ error: 'Invalid expiry' }, 400);
      if (Date.parse(expiresAt) > Date.parse(session.expiresAt)
        && settlementNumber < session.nextExtensionSettlement) {
        return json({ error: 'Extension TTL was applied before payment settlement' }, 409);
      }
      if (Date.parse(expiresAt) > Date.parse(session.expiresAt)) {
        session.nextExtensionSettlement = settlementNumber + 1;
      }
      session.expiresAt = expiresAt;
      return json(sessionResponse(session));
    }

    const accessTtlMatch = url.pathname.match(/^\/internal\/session\/([^/]+)\/access-ttl$/);
    if (accessTtlMatch && request.method === 'PATCH') {
      const sessionId = decodeURIComponent(accessTtlMatch[1]!);
      const session = sessions.get(sessionId);
      if (!session) return json({ error: 'Session not found' }, 404);
      const body = await request.json() as Record<string, unknown>;
      const expiresAt = String(body.expiresAt || '');
      if (expiresAt !== session.expiresAt) {
        return json({ error: 'Access deadline must match active session deadline' }, 409);
      }
      session.publicAccessExpiresAt = expiresAt;
      return json(sessionResponse(session));
    }

    const reallocateMatch = url.pathname.match(/^\/internal\/session\/([^/]+)\/reallocate-expired$/);
    if (reallocateMatch && request.method === 'POST') {
      const sessionId = decodeURIComponent(reallocateMatch[1]!);
      const body = await request.json() as Record<string, unknown>;
      const expiresAt = String(body.expiresAt || '');
      if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
        return json({ error: 'Invalid recovery expiry' }, 400);
      }
      const existing = sessions.get(sessionId);
      if (existing && Date.parse(existing.expiresAt) > Date.now()) {
        return json(sessionResponse(existing));
      }
      const session = {
        sessionId,
        expiresAt,
        publicAccessExpiresAt: expiresAt,
        nextExtensionSettlement: settlementNumber + 1,
      };
      sessions.set(sessionId, session);
      return json(sessionResponse(session));
    }

    const sessionMatch = url.pathname.match(/^\/internal\/session\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const session = sessions.get(sessionId);
      if (!session) return json({ error: 'Session not found' }, 404);
      if (request.method === 'GET') return json(sessionResponse(session));
      if (request.method === 'DELETE') {
        sessions.delete(sessionId);
        return json({ success: true, sessionId });
      }
    }

    return json({ error: 'Not found' }, 404);
  },
});

console.log(`x402 smoke dependencies listening on http://127.0.0.1:${port}`);
