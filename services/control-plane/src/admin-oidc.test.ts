import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readAdminAuthConfig } from './admin-auth';
import { authorizeOidcClaims, createOidcFlow, isOidcConfigured, readOidcFlow } from './admin-oidc';

const config = readAdminAuthConfig({
  ADMIN_AUTH_STRATEGIES: 'oidc',
  ADMIN_SESSION_SECRET: 'test-secret',
  ADMIN_OIDC_ISSUER: 'https://keycloak.example.com/realms/employees',
  ADMIN_OIDC_CLIENT_ID: 'popcorn',
  ADMIN_OIDC_REDIRECT_URI: 'https://control-plane.example.com/auth/callback',
  ADMIN_OIDC_REQUIRED_ROLE: 'app:popcorn:access',
});

describe('admin OIDC login', () => {
  test('uses authorization code with PKCE and a fixed callback', () => {
    expect(isOidcConfigured(config)).toBe(true);
    const { cookie, authorizationUrl } = createOidcFlow(config, 1000);
    const url = new URL(authorizationUrl);
    const flow = readOidcFlow(cookie, url.searchParams.get('state')!, config, 2000);
    expect(url.pathname).toBe('/realms/employees/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe('popcorn');
    expect(url.searchParams.get('redirect_uri')).toBe('https://control-plane.example.com/auth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(flow!.verifier).digest('base64url'));
    expect(readOidcFlow(cookie, 'wrong', config, 2000)).toBeNull();
    expect(readOidcFlow(`${cookie}tampered`, url.searchParams.get('state')!, config, 2000)).toBeNull();
    expect(readOidcFlow(cookie, url.searchParams.get('state')!, config, 302000)).toBeNull();
  });

  test('requires the configured role and matching nonce', () => {
    const claims = { sub: 'user-1', nonce: 'nonce-1', name: 'Operator', realm_access: { roles: ['app:popcorn:access'] } };
    expect(authorizeOidcClaims(claims, 'nonce-1', 'app:popcorn:access')).toEqual({ id: 'user-1', displayName: 'Operator', strategy: 'oidc' });
    expect(authorizeOidcClaims(claims, 'wrong', 'app:popcorn:access')).toBeNull();
    expect(authorizeOidcClaims(claims, 'nonce-1', 'app:other:access')).toBeNull();
  });
});
