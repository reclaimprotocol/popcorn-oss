import type { RegionConfig } from './config';
import { summarizeAttemptError, type RegionAttempt } from './regions';

export interface RoutedSessionAccessPolicy {
  tokenMode: 'expiring' | 'route-bound';
  cdpScope: 'restricted' | 'automation';
  accessExpiresAt?: string;
}

export interface RoutedSessionRequest {
  sessionId: string;
  clientId: string;
  clientName: string;
  expiresAt?: string;
  tokenExpiresAt?: string;
  accessPolicy?: RoutedSessionAccessPolicy;
  proxy?: { country: string };
}

export interface PoolManagerSessionResponse {
  success: boolean;
  sessionId: string;
  url: string;
  cdpUrl: string;
  cdpInternalUrl?: string;
  apiUrl: string;
  vncUrl: string;
  vncWsUrl: string;
  browserPodId?: string;
  [key: string]: unknown;
}

export interface RoutedSessionResponse extends PoolManagerSessionResponse {
  region: string;
  clusterName: string;
}

export interface AllocationResult {
  session?: RoutedSessionResponse;
  attempt: RegionAttempt;
}

async function readJsonSafe(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function regionalDeadline(): AbortSignal {
  return AbortSignal.timeout(30_000);
}

function serviceHeaders(serviceAuthToken: string): HeadersInit {
  return {
    'Authorization': `Bearer ${serviceAuthToken}`,
    'Content-Type': 'application/json',
  };
}

function regionServiceAuthToken(region: RegionConfig, fallbackToken: string): string {
  return region.serviceAuthToken || fallbackToken;
}

export function isRoutedSessionResponse(body: unknown, expectedSessionId: string): body is PoolManagerSessionResponse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const candidate = body as Record<string, unknown>;
  return candidate.success === true
    && candidate.sessionId === expectedSessionId
    && typeof candidate.url === 'string' && candidate.url.length > 0
    && typeof candidate.cdpUrl === 'string' && candidate.cdpUrl.length > 0
    && typeof candidate.apiUrl === 'string' && candidate.apiUrl.length > 0
    && typeof candidate.vncUrl === 'string' && candidate.vncUrl.length > 0
    && typeof candidate.vncWsUrl === 'string' && candidate.vncWsUrl.length > 0;
}

function sessionTokenFromUrl(value: unknown, sessionId: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const segments = new URL(value).pathname.split('/').filter(Boolean);
    const sessionIndex = segments.findIndex((segment) => {
      try {
        return decodeURIComponent(segment) === sessionId;
      } catch {
        return false;
      }
    });
    return sessionIndex >= 0 && segments[sessionIndex + 1] ? segments[sessionIndex + 1] : null;
  } catch {
    return null;
  }
}

export function withDefaultLiveViewUrls(
  body: unknown,
  publicGatewayUrl: string,
  sessionId: string,
): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const session = body as Record<string, unknown>;
  if (typeof session.vncUrl === 'string' && session.vncUrl
    && typeof session.vncWsUrl === 'string' && session.vncWsUrl) {
    return session;
  }

  const token = sessionTokenFromUrl(session.vncUrl, sessionId)
    || sessionTokenFromUrl(session.url, sessionId);
  if (!token) return session;

  try {
    const gateway = new URL(publicGatewayUrl);
    if (gateway.protocol !== 'http:' && gateway.protocol !== 'https:') return session;
    gateway.search = '';
    gateway.hash = '';
    const baseUrl = gateway.href.replace(/\/+$/, '');
    gateway.protocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:';
    const websocketUrl = gateway.href.replace(/\/+$/, '');
    return {
      ...session,
      ...(typeof session.vncUrl === 'string' && session.vncUrl ? {} : {
        vncUrl: `${baseUrl}/liveview/${sessionId}/${token}/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000`,
      }),
      ...(typeof session.vncWsUrl === 'string' && session.vncWsUrl ? {} : {
        vncWsUrl: `${websocketUrl}/liveview-ws/${sessionId}/${token}`,
      }),
    };
  } catch {
    return session;
  }
}

export async function allocateInRegion(
  region: RegionConfig,
  request: RoutedSessionRequest,
  serviceAuthToken: string,
): Promise<AllocationResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${region.poolManagerUrl}/internal/sessions`, {
      method: 'POST',
      headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
      body: JSON.stringify({
        ...request,
        publicGatewayUrl: region.publicGatewayUrl,
      }),
      signal: regionalDeadline(),
    });
    const body = await readJsonSafe(response);

    if (!response.ok) {
      return {
        attempt: {
          region: region.name,
          clusterName: region.clusterName,
          status: 'failed',
          statusCode: response.status,
          latencyMs: Date.now() - startedAt,
          error: summarizeAttemptError(response.status, body),
        },
      };
    }

    const sessionBody = withDefaultLiveViewUrls(body, region.publicGatewayUrl, request.sessionId);
    if (!isRoutedSessionResponse(sessionBody, request.sessionId)) {
      return {
        attempt: {
          region: region.name,
          clusterName: region.clusterName,
          status: 'failed',
          statusCode: response.status,
          latencyMs: Date.now() - startedAt,
          error: 'Pool manager returned an invalid successful session response',
        },
      };
    }

    return {
      session: {
        ...sessionBody,
        region: region.name,
        clusterName: region.clusterName,
      },
      attempt: {
        region: region.name,
        clusterName: region.clusterName,
        status: 'success',
        statusCode: response.status,
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      attempt: {
        region: region.name,
        clusterName: region.clusterName,
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        error: (error as Error).message,
      },
    };
  }
}

export async function getRegionalSession(region: RegionConfig, sessionId: string, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}?publicGatewayUrl=${encodeURIComponent(region.publicGatewayUrl)}`, {
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
    signal: regionalDeadline(),
  });
  const body = await readJsonSafe(response);
  return { response, body: withDefaultLiveViewUrls(body, region.publicGatewayUrl, sessionId) };
}

export async function deleteRegionalSession(region: RegionConfig, sessionId: string, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
    signal: regionalDeadline(),
  });
  return { response, body: await readJsonSafe(response) };
}

export async function extendRegionalSessionTtl(region: RegionConfig, sessionId: string, expiresAt: string, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}/ttl?publicGatewayUrl=${encodeURIComponent(region.publicGatewayUrl)}`, {
    method: 'PATCH',
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
    body: JSON.stringify({ expiresAt }),
    signal: regionalDeadline(),
  });
  const body = await readJsonSafe(response);
  return { response, body: withDefaultLiveViewUrls(body, region.publicGatewayUrl, sessionId) };
}

export async function activateRegionalSessionAccess(region: RegionConfig, sessionId: string, expiresAt: string, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}/access-ttl?publicGatewayUrl=${encodeURIComponent(region.publicGatewayUrl)}`, {
    method: 'PATCH',
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
    body: JSON.stringify({ expiresAt }),
    signal: regionalDeadline(),
  });
  const body = await readJsonSafe(response);
  return { response, body: withDefaultLiveViewUrls(body, region.publicGatewayUrl, sessionId) };
}

export async function reallocateExpiredRegionalSession(
  region: RegionConfig,
  sessionId: string,
  expiresAt: string,
  serviceAuthToken: string,
  request?: Pick<RoutedSessionRequest,
    'clientId' | 'clientName' | 'tokenExpiresAt' | 'accessPolicy'>,
) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}/reallocate-expired`, {
    method: 'POST',
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
    body: JSON.stringify({
      expiresAt,
      publicGatewayUrl: region.publicGatewayUrl,
      ...request,
    }),
    signal: regionalDeadline(),
  });
  const body = await readJsonSafe(response);
  return { response, body: withDefaultLiveViewUrls(body, region.publicGatewayUrl, sessionId) };
}

export async function getRegionalServers(region: RegionConfig, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/servers`, {
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
    signal: regionalDeadline(),
  });
  return { response, body: await readJsonSafe(response) };
}
