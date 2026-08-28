import crypto from 'crypto';
import { McpConfig } from './config';
import type { McpStore, OAuthClient } from './store';

/**
 * Minimal MCP-native OAuth 2.1 authorization server.
 *
 * - PKCE (S256) is REQUIRED; there are no client secrets and no implicit flow.
 * - Access tokens are stateless, HMAC-signed, and bound to an OAuth subject.
 *   The subject is the only identity used for Popcorn credit; an auth header
 *   never itself authorizes a charge.
 */

export const SCOPES = ['popcorn.sessions', 'popcorn.credit'] as const;

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function sign(payload: string): string {
  return crypto.createHmac('sha256', McpConfig.tokenSigningKey).update(payload).digest('base64url');
}

export function verifyChallenge(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type AccessToken = { sub: string; scope: string; aud: string; iat: number; exp: number; iss: string };

/** The canonical resource identifier of this MCP server (RFC 8707 audience). */
export const RESOURCE_URI = () => `${McpConfig.publicUrl}/mcp`;

/** RFC 8707 `resource`: must match this server, if the client sends one. */
export function resourceMatches(resource: string | undefined | null): boolean {
  if (!resource) return true;
  const canonical = RESOURCE_URI();
  try {
    const provided = new URL(resource);
    provided.hash = '';
    return provided.toString().replace(/\/$/, '') === canonical.replace(/\/$/, '');
  } catch {
    return false;
  }
}

export function issueAccessToken(subject: string, scope: string, now = Date.now()): string {
  const claims: AccessToken = {
    sub: subject,
    scope,
    aud: RESOURCE_URI(),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + McpConfig.accessTokenTtlSeconds,
    iss: McpConfig.publicUrl,
  };
  const body = base64url(JSON.stringify(claims));
  return `${body}.${sign(body)}`;
}

export function verifyAccessToken(token: string, now = Date.now()): AccessToken | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = sign(body);
  if (expected.length !== signature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as AccessToken;
    if (claims.exp * 1000 <= now) return null;
    if (claims.iss !== McpConfig.publicUrl) return null;
    if (claims.aud !== RESOURCE_URI()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function authorizationServerMetadata() {
  return {
    issuer: McpConfig.publicUrl,
    authorization_endpoint: `${McpConfig.publicUrl}/oauth/authorize`,
    token_endpoint: `${McpConfig.publicUrl}/oauth/token`,
    registration_endpoint: `${McpConfig.publicUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
  };
}

export function protectedResourceMetadata() {
  return {
    resource: RESOURCE_URI(),
    authorization_servers: [McpConfig.publicUrl],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export async function registerClient(
  store: McpStore,
  body: { client_name?: unknown; redirect_uris?: unknown },
): Promise<{ error: string } | OAuthClient> {
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)
    : [];
  if (redirectUris.length === 0) {
    return { error: 'redirect_uris is required' };
  }
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return { error: `invalid redirect_uri: ${uri}` };
    }
    const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (parsed.protocol !== 'https:' && !isLoopback) {
      return { error: 'redirect_uri must use https, or loopback for local clients' };
    }
  }
  const client: OAuthClient = {
    clientId: `mcp_${crypto.randomBytes(16).toString('hex')}`,
    clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'MCP client',
    redirectUris,
    createdAt: Date.now(),
  };
  await store.putClient(client);
  return client;
}

export function newAuthorizationCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Stable pseudonymous subject for an authenticated Popcorn account. */
export function subjectFor(accountId: string): string {
  return `popcorn:${crypto.createHash('sha256').update(`${McpConfig.tokenSigningKey}:${accountId}`).digest('hex').slice(0, 32)}`;
}
