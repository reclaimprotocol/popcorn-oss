import type { RegionConfig } from './config';
import { summarizeAttemptError, type RegionAttempt } from './regions';

export interface RoutedSessionRequest {
  sessionId: string;
  clientId: string;
  clientName: string;
  expiresAt?: string;
}

export interface RoutedSessionResponse {
  success: boolean;
  sessionId: string;
  url: string;
  cdpUrl: string;
  cdpInternalUrl?: string;
  apiUrl: string;
  browserPodId?: string;
  region: string;
  clusterName: string;
  [key: string]: unknown;
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

function serviceHeaders(serviceAuthToken: string): HeadersInit {
  return {
    'Authorization': `Bearer ${serviceAuthToken}`,
    'Content-Type': 'application/json',
  };
}

function regionServiceAuthToken(region: RegionConfig, fallbackToken: string): string {
  return region.serviceAuthToken || fallbackToken;
}

export async function allocateInRegion(
  region: RegionConfig,
  request: RoutedSessionRequest,
  serviceAuthToken: string,
): Promise<AllocationResult> {
  try {
    const response = await fetch(`${region.poolManagerUrl}/internal/sessions`, {
      method: 'POST',
      headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
      body: JSON.stringify({
        ...request,
        publicGatewayUrl: region.publicGatewayUrl,
      }),
    });
    const body = await readJsonSafe(response);

    if (!response.ok) {
      return {
        attempt: {
          region: region.name,
          clusterName: region.clusterName,
          status: 'failed',
          statusCode: response.status,
          error: summarizeAttemptError(response.status, body),
        },
      };
    }

    return {
      session: {
        ...body,
        region: region.name,
        clusterName: region.clusterName,
      },
      attempt: {
        region: region.name,
        clusterName: region.clusterName,
        status: 'success',
        statusCode: response.status,
      },
    };
  } catch (error) {
    return {
      attempt: {
        region: region.name,
        clusterName: region.clusterName,
        status: 'failed',
        error: (error as Error).message,
      },
    };
  }
}

export async function getRegionalSession(region: RegionConfig, sessionId: string, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}?publicGatewayUrl=${encodeURIComponent(region.publicGatewayUrl)}`, {
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
  });
  return { response, body: await readJsonSafe(response) };
}

export async function deleteRegionalSession(region: RegionConfig, sessionId: string, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
  });
  return { response, body: await readJsonSafe(response) };
}

export async function extendRegionalSessionTtl(region: RegionConfig, sessionId: string, expiresAt: string, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/session/${encodeURIComponent(sessionId)}/ttl?publicGatewayUrl=${encodeURIComponent(region.publicGatewayUrl)}`, {
    method: 'PATCH',
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
    body: JSON.stringify({ expiresAt }),
  });
  return { response, body: await readJsonSafe(response) };
}

export async function getRegionalServers(region: RegionConfig, serviceAuthToken: string) {
  const response = await fetch(`${region.poolManagerUrl}/internal/servers`, {
    headers: serviceHeaders(regionServiceAuthToken(region, serviceAuthToken)),
  });
  return { response, body: await readJsonSafe(response) };
}
