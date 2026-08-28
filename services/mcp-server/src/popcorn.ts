import { McpConfig } from './config';

/**
 * Control-plane client. The MCP adapter is a single operator client of the
 * standard Popcorn API; end users are distinguished by OAuth subject, not by
 * separate Popcorn client credentials.
 */

/** Raw control-plane session (see services/control-plane pool-manager types). */
export type PopcornSession = {
  sessionId: string;
  /** Live view for a human. The control plane returns `url` and `vncUrl`. */
  url?: string;
  vncUrl?: string;
  cdpUrl?: string;
  expiresAt?: string;
  region?: string;
  [key: string]: unknown;
};

/** Normalized view used by the tool layer. */
export type SessionView = {
  sessionId: string;
  liveViewUrl: string | null;
  cdpUrl: string | null;
  expiresAt: string | null;
  region: string | null;
  raw: PopcornSession;
};

export function toSessionView(session: PopcornSession): SessionView {
  return {
    sessionId: session.sessionId,
    liveViewUrl: (session.vncUrl as string) ?? (session.url as string) ?? null,
    cdpUrl: (session.cdpUrl as string) ?? null,
    expiresAt: (session.expiresAt as string) ?? null,
    region: (session.region as string) ?? null,
    raw: session,
  };
}

export type PopcornResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function authHeader(): Record<string, string> {
  return {
    authorization: `Bearer ${McpConfig.controlPlaneClientId}:${McpConfig.controlPlaneClientSecret}`,
    'content-type': 'application/json',
  };
}

async function call<T>(path: string, init: RequestInit): Promise<PopcornResult<T>> {
  const response = await fetch(`${McpConfig.controlPlaneUrl}${path}`, {
    ...init,
    headers: { ...authHeader(), ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: body?.error ?? `control-plane error ${response.status}` };
  }
  return { ok: true, data: body as T };
}

export function createSession(input: {
  ttlSeconds: number;
  metadata: Record<string, unknown>;
}): Promise<PopcornResult<PopcornSession>> {
  return call<PopcornSession>('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ ttlSeconds: input.ttlSeconds, metadata: input.metadata }),
  });
}

export function getSession(sessionId: string): Promise<PopcornResult<PopcornSession>> {
  return call<PopcornSession>(`/v1/session/${encodeURIComponent(sessionId)}`, { method: 'GET' });
}

/** The control plane's contract is `extendBySeconds`, not `ttlSeconds`. */
export function extendSession(sessionId: string, extendBySeconds: number): Promise<PopcornResult<PopcornSession>> {
  return call<PopcornSession>(`/v1/session/${encodeURIComponent(sessionId)}/ttl`, {
    method: 'PATCH',
    body: JSON.stringify({ extendBySeconds }),
  });
}

export function getSessionAttestation(sessionId: string): Promise<PopcornResult<Record<string, unknown>>> {
  return call<Record<string, unknown>>(`/v1/session/${encodeURIComponent(sessionId)}/attestation`, { method: 'GET' });
}

export function endSession(sessionId: string): Promise<PopcornResult<Record<string, unknown>>> {
  return call<Record<string, unknown>>(`/v1/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}
