import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AdminAuthConfig, AdminIdentity } from './admin-auth';

export const ADMIN_OIDC_FLOW_COOKIE = 'control_plane_admin_oidc_flow';
const FLOW_TTL_SECONDS = 300;

interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

export function isOidcConfigured(config: AdminAuthConfig): boolean {
  if (!config.strategies.has('oidc') || !config.sessionSecret || !config.oidcIssuer
      || !config.oidcClientId || !config.oidcRedirectUri || !config.oidcRequiredRole) return false;
  try {
    const issuer = new URL(config.oidcIssuer);
    const redirect = new URL(config.oidcRedirectUri);
    return issuer.protocol === 'https:' && redirect.protocol === 'https:'
      && !issuer.search && !issuer.hash && redirect.pathname === '/auth/callback'
      && !redirect.search && !redirect.hash;
  } catch {
    return false;
  }
}

export function createOidcFlow(config: AdminAuthConfig, now = Date.now()): { cookie: string; authorizationUrl: string } {
  if (!isOidcConfigured(config)) throw new Error('OIDC admin login is not configured');
  const flow: OidcFlow = {
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    expiresAt: now + FLOW_TTL_SECONDS * 1000,
  };
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  const cookie = `${payload}.${sign(payload, config.sessionSecret!)}`;
  const url = new URL(`${config.oidcIssuer!.replace(/\/$/, '')}/protocol/openid-connect/auth`);
  url.searchParams.set('client_id', config.oidcClientId!);
  url.searchParams.set('redirect_uri', config.oidcRedirectUri!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', flow.state);
  url.searchParams.set('nonce', flow.nonce);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', createHash('sha256').update(flow.verifier).digest('base64url'));
  return { cookie, authorizationUrl: url.toString() };
}

export function readOidcFlow(cookie: string | undefined, state: string | undefined, config: AdminAuthConfig, now = Date.now()): OidcFlow | null {
  if (!cookie || !state || !config.sessionSecret) return null;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature || !equal(signature, sign(payload, config.sessionSecret))) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OidcFlow;
    if (!flow.state || !flow.nonce || !flow.verifier || !Number.isFinite(flow.expiresAt)
        || flow.expiresAt < now || !equal(flow.state, state)) return null;
    return flow;
  } catch {
    return null;
  }
}

export async function exchangeOidcCode(code: string, flow: OidcFlow, config: AdminAuthConfig): Promise<AdminIdentity | null> {
  if (!isOidcConfigured(config)) throw new Error('OIDC admin login is not configured');
  const issuer = config.oidcIssuer!.replace(/\/$/, '');
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.oidcClientId!,
      redirect_uri: config.oidcRedirectUri!,
      code,
      code_verifier: flow.verifier,
    }),
  });
  if (!response.ok) throw new Error(`OIDC token exchange failed with ${response.status}`);
  const tokens = await response.json() as { id_token?: string };
  if (!tokens.id_token) throw new Error('OIDC token exchange did not return an ID token');
  const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer,
    audience: config.oidcClientId!,
    algorithms: ['RS256'],
  });
  return authorizeOidcClaims(payload, flow.nonce, config.oidcRequiredRole!);
}

export function authorizeOidcClaims(payload: Record<string, unknown>, nonce: string, requiredRole: string): AdminIdentity | null {
  if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub) return null;
  const roles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
  if (!Array.isArray(roles) || !roles.includes(requiredRole)) return null;
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  return { id: payload.sub, displayName: name || email || payload.sub, strategy: 'oidc' };
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
