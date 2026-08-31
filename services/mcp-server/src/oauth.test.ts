import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { InMemoryStore } from './store';
import { issueAccessToken, registerClient, verifyAccessToken, verifyChallenge } from './oauth';

describe('oauth', () => {
  test('registers clients with https or loopback redirects only', async () => {
    const store = new InMemoryStore();
    const bad = await registerClient(store, { client_name: 'x', redirect_uris: ['http://evil.example/cb'] });
    expect('error' in bad).toBe(true);

    const good = await registerClient(store, { client_name: 'x', redirect_uris: ['http://127.0.0.1:9000/cb'] });
    expect('clientId' in good).toBe(true);
  });

  test('rejects registration without redirect_uris', async () => {
    const store = new InMemoryStore();
    expect(await registerClient(store, {})).toEqual({ error: 'redirect_uris is required' });
  });

  test('verifies S256 PKCE challenges', () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(verifyChallenge(verifier, challenge)).toBe(true);
    expect(verifyChallenge('wrong-verifier', challenge)).toBe(false);
  });

  test('issues and verifies subject-bound access tokens', () => {
    const token = issueAccessToken('popcorn:abc', 'popcorn.sessions');
    expect(verifyAccessToken(token)?.sub).toBe('popcorn:abc');
    expect(verifyAccessToken(`${token}tampered`)).toBeNull();
  });

  test('rejects expired tokens', () => {
    const token = issueAccessToken('popcorn:abc', 'popcorn.sessions');
    expect(verifyAccessToken(token, Date.now() + 86_400_000)).toBeNull();
  });

  test('authorization codes are single use', async () => {
    const store = new InMemoryStore();
    await store.putCode({
      code: 'c1',
      clientId: 'client',
      subject: 'popcorn:abc',
      redirectUri: 'https://app.example/cb',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'popcorn.sessions',
      resource: 'http://localhost:3000/mcp',
      expiresAt: Date.now() + 60_000,
      consumed: false,
    });
    expect((await store.consumeCode('c1'))?.subject).toBe('popcorn:abc');
    expect(await store.consumeCode('c1')).toBeNull();
  });
});
