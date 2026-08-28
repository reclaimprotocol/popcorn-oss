import { describe, expect, test } from 'bun:test';
import { toSessionView } from './popcorn';
import { RESOURCE_URI, issueAccessToken, resourceMatches, verifyAccessToken } from './oauth';

describe('control-plane wire contract', () => {
  test('live view comes from vncUrl / url, not a made-up field', () => {
    expect(toSessionView({ sessionId: 's', vncUrl: 'https://gw/liveview/s' }).liveViewUrl).toBe('https://gw/liveview/s');
    expect(toSessionView({ sessionId: 's', url: 'https://gw/u' }).liveViewUrl).toBe('https://gw/u');
    expect(toSessionView({ sessionId: 's' }).liveViewUrl).toBeNull();
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
    expect(resourceMatches(undefined)).toBe(true);
  });
});
