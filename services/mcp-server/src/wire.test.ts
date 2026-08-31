import { describe, expect, test } from 'bun:test';
import { createSessionRequestBody, toSessionView } from './popcorn';
import { RESOURCE_URI, issueAccessToken, resourceMatches, verifyAccessToken } from './oauth';

describe('control-plane wire contract', () => {
  test('live view comes from vncUrl / url, not a made-up field', () => {
    expect(toSessionView({ sessionId: 's', vncUrl: 'https://gw/liveview/s' }).liveViewUrl).toBe('https://gw/liveview/s');
    expect(toSessionView({ sessionId: 's', url: 'https://gw/u' }).liveViewUrl).toBe('https://gw/u');
    expect(toSessionView({ sessionId: 's' }).liveViewUrl).toBeNull();
  });

  test('agent CDP comes only from the trusted internal endpoint', () => {
    const view = toSessionView({
      sessionId: 's',
      cdpUrl: 'wss://gw/cdp/s/restricted-token/',
      cdpInternalUrl: 'wss://gw/cdp-internal/s/internal-token/',
    });
    expect(view.agentCdpUrl).toBe('wss://gw/cdp-internal/s/internal-token/');
    expect(toSessionView({ sessionId: 's', cdpUrl: 'wss://gw/cdp/s/restricted-token/' }).agentCdpUrl).toBeNull();
  });

  test('session placement forwards nearest-first regions and a managed proxy country', () => {
    expect(createSessionRequestBody({
      sessionId: 's',
      ttlSeconds: 600,
      metadata: { purpose: 'test' },
      regions: ['asia-south1', 'us-central1'],
      proxyCountry: 'IN',
    })).toEqual({
      sessionId: 's',
      ttlSeconds: 600,
      metadata: { purpose: 'test' },
      browserMode: 'normal',
      regions: ['asia-south1', 'us-central1'],
      proxy: { country: 'IN' },
    });
  });

  test('session placement omits proxy and region fields when not requested', () => {
    expect(createSessionRequestBody({ sessionId: 's', ttlSeconds: 600, metadata: {} }))
      .toEqual({ sessionId: 's', ttlSeconds: 600, metadata: {}, browserMode: 'normal' });
  });
});

describe('resource binding', () => {
  test('tokens are audience-bound to this MCP endpoint', () => {
    const token = issueAccessToken('popcorn:abc', 'popcorn.sessions');
    expect(verifyAccessToken(token)?.aud).toBe(RESOURCE_URI());
  });

  test('a mismatched RFC 8707 resource is rejected', () => {
    expect(resourceMatches(RESOURCE_URI())).toBe(true);
    expect(resourceMatches('https://evil.example/mcp')).toBe(false);
    // RFC 8707 resource is REQUIRED, so absent is a rejection.
    expect(resourceMatches(undefined)).toBe(false);
  });
});
