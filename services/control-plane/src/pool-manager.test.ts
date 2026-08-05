import { afterEach, describe, expect, test } from 'bun:test';
import { allocateInRegion, isRoutedSessionResponse, withDefaultLiveViewUrls } from './pool-manager';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const region = {
  name: 'test-region',
  clusterName: 'test-cluster',
  poolManagerUrl: 'http://pool-manager.test',
  publicGatewayUrl: 'https://gateway.example',
  enabled: true,
};

describe('regional pool-manager response contract', () => {
  test('accepts the required flat compatibility response', () => {
    expect(isRoutedSessionResponse({
      success: true,
      sessionId: 'session-1',
      url: 'https://gateway.example/liveview/session-1/token/',
      cdpUrl: 'wss://gateway.example/cdp/session-1/token/',
      apiUrl: 'https://gateway.example/api/session-1/token/',
      vncUrl: 'https://gateway.example/liveview/session-1/token/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      vncWsUrl: 'wss://gateway.example/liveview-ws/session-1/token',
    }, 'session-1')).toBe(true);
  });

  test('derives canonical fields from an older pool-manager response during rolling upgrades', async () => {
    const legacyResponse = {
      success: true,
      sessionId: 'session-1',
      url: 'https://legacy-gateway.example/vnc/session-1/restricted.jwt/liveview.html',
      cdpUrl: 'wss://legacy-gateway.example/cdp/session-1/restricted.jwt/',
      apiUrl: 'https://legacy-gateway.example/api/session-1/internal.jwt/',
    };
    expect(withDefaultLiveViewUrls(legacyResponse, 'http://localhost:8080/base/', 'session-1')).toMatchObject({
      vncUrl: 'http://localhost:8080/base/liveview/session-1/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      vncWsUrl: 'ws://localhost:8080/base/liveview-ws/session-1/restricted.jwt',
    });

    globalThis.fetch = async () => Response.json(legacyResponse);
    const result = await allocateInRegion(region, {
      sessionId: 'session-1',
      clientId: 'client-1',
      clientName: 'Client 1',
    }, 'service-token');
    expect(result.session).toMatchObject({
      vncUrl: 'https://gateway.example/liveview/session-1/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      vncWsUrl: 'wss://gateway.example/liveview-ws/session-1/restricted.jwt',
    });
  });

  test('rejects malformed 2xx bodies and mismatched sessions', () => {
    expect(isRoutedSessionResponse(null, 'session-1')).toBe(false);
    expect(isRoutedSessionResponse({ success: true, sessionId: 'session-1' }, 'session-1')).toBe(false);
    expect(isRoutedSessionResponse({
      success: true,
      sessionId: 'other-session',
      url: 'https://gateway.example/liveview',
      cdpUrl: 'wss://gateway.example/cdp',
      apiUrl: 'https://gateway.example/api',
      vncUrl: 'https://gateway.example/liveview/other-session/token/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      vncWsUrl: 'wss://gateway.example/liveview-ws/other-session/token',
    }, 'session-1')).toBe(false);
    expect(isRoutedSessionResponse({
      success: true,
      sessionId: 'session-1',
      url: 'https://gateway.example/liveview/session-1/token/liveview.html',
      cdpUrl: 'wss://gateway.example/cdp/session-1/token/',
      apiUrl: 'https://gateway.example/api/session-1/token/',
      vncUrl: 'https://gateway.example/liveview/session-1/token/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
    }, 'session-1')).toBe(false);
  });

  test('treats a malformed successful allocation as a failed region attempt', async () => {
    globalThis.fetch = async () => Response.json({ success: true, sessionId: 'session-1' });
    const result = await allocateInRegion(region, {
      sessionId: 'session-1',
      clientId: 'client-1',
      clientName: 'Client 1',
    }, 'service-token');

    expect(result.session).toBeUndefined();
    expect(result.attempt).toMatchObject({
      status: 'failed',
      statusCode: 200,
      error: 'Pool manager returned an invalid successful session response',
    });
  });

  test('forwards the generic access contract', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        sessionId: 'session-1',
        url: 'https://gateway.example/liveview/session-1/token/',
        cdpUrl: 'wss://gateway.example/cdp-agent/session-1/token/',
        apiUrl: 'https://gateway.example/api/session-1/token/',
        vncUrl: 'https://gateway.example/liveview/session-1/token/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
        vncWsUrl: 'wss://gateway.example/liveview-ws/session-1/token',
      });
    };
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const result = await allocateInRegion(region, {
      sessionId: 'session-1',
      clientId: 'x402-public',
      clientName: 'Public x402',
      expiresAt,
      tokenExpiresAt: expiresAt,
      accessPolicy: {
        tokenMode: 'route-bound',
        cdpScope: 'automation',
        accessExpiresAt: expiresAt,
      },
    }, 'service-token');

    expect(result.session?.sessionId).toBe('session-1');
    expect(result.session).toMatchObject({
      vncUrl: 'https://gateway.example/liveview/session-1/token/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
      vncWsUrl: 'wss://gateway.example/liveview-ws/session-1/token',
    });
    expect(requestBody).toMatchObject({
      publicGatewayUrl: region.publicGatewayUrl,
      tokenExpiresAt: expiresAt,
      accessPolicy: {
        tokenMode: 'route-bound',
        cdpScope: 'automation',
        accessExpiresAt: expiresAt,
      },
    });
  });
});
