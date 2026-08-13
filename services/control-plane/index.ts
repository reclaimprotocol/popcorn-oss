import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import crypto from 'crypto';
import {
  ADMIN_OAUTH_STATE_COOKIE,
  ADMIN_SESSION_COOKIE,
  authenticateBasicAdmin,
  authenticateBearerAdmin,
  authorizeGoogleUser,
  buildGoogleAuthorizationUrl,
  createAdminSession,
  createOauthState,
  fetchGoogleUserInfo,
  isAdminAuthPath,
  isGoogleOAuthConfigured,
  isPasswordLoginConfigured,
  isSameOriginAdminRequest,
  readAdminAuthConfig,
  verifyAdminPassword,
  verifyAdminSession,
  verifyOauthState,
  wantsHtml,
} from './src/admin-auth';
import { ClientService } from './src/clients';
import { ControlPlaneConfig } from './src/config';
import { allocateInRegion, deleteRegionalSession, extendRegionalSessionTtl, getRegionalServers, getRegionalSession } from './src/pool-manager';
import { selectRegions } from './src/regions';
import { SessionService } from './src/sessions';
import { buildSessionAllocationEvent, buildSessionAnalyticsMetadata } from './src/session-analytics';
import {
  getActiveSessionCount,
  getSessionsByRegion,
  getSessionAllocationStats,
  getSessionTimeSeries,
  getSessionWindowStats,
  getStaleActiveSessionCount,
  getTopClients,
} from './src/stats';
import { expiresAtFromTtlSeconds, extendExpiresAt, readOptionalSeconds, validateTtlSeconds } from './src/ttl';
import { X402PaymentGateway } from './src/x402-payment';
import { createX402SessionController, type X402HttpResult } from './src/x402-sessions';
import { getX402Analytics } from './src/x402-analytics';
import { X402Store } from './src/x402-store';
import { selectTrustedClientAddress } from './src/x402-utils';
import { readBoundedJsonBody } from './src/http-body';
import {
  renderClientSessionsPanelHtml,
  renderAnalyticsViewHtml,
  renderClientsViewHtml,
  renderClustersViewHtml,
  renderShellHtml,
  toAdminRegion,
  type ActionNotice,
  type AdminRegion,
  type AnalyticsData,
  type AnalyticsScope,
  type X402AnalyticsData,
} from './src/admin-ui';

const app = new Hono();
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_COUNTRY_CODES = new Set((
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(' '));
const ADMIN_CLIENT_ID = 'admin';
const X402_PUBLIC_CLIENT_ID = 'x402-public';
const ADMIN_CLIENT_NAME = 'Admin UI';
const ADMIN_AUTH_CONFIG = readAdminAuthConfig();
const X402_CONTROLLER = ControlPlaneConfig.x402.enabled
  ? createX402SessionController({
    config: ControlPlaneConfig.x402,
    regions: ControlPlaneConfig.regions,
    serviceAuthToken: ControlPlaneConfig.serviceAuthToken,
    gateway: new X402PaymentGateway(ControlPlaneConfig.x402),
  })
  : null;
let lastX402StaleCleanupAt = 0;
let lastX402ReconciliationAt = 0;

if (X402_CONTROLLER) {
  const reconciliationTimer = setInterval(() => {
    void X402_CONTROLLER.reconcilePendingSettlements().catch((error) => {
      console.error('Failed to reconcile pending x402 settlements:', error);
    });
  }, 5_000);
  reconciliationTimer.unref();
}

console.log(`🚀 Starting Control Plane on port ${ControlPlaneConfig.port}...`);
console.log(`🌎 Configured regions: ${ControlPlaneConfig.regions.map((region) => region.name).join(', ') || 'none'}`);

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getBearerCredential(c: any): string | null {
  const header = c.req.header('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isServiceAuthorized(c: any): boolean {
  const token = getBearerCredential(c);
  if (!token) {
    return false;
  }
  if (timingSafeEqual(token, ControlPlaneConfig.serviceAuthToken)) {
    return true;
  }
  return ControlPlaneConfig.regions.some((region) => region.serviceAuthToken && timingSafeEqual(token, region.serviceAuthToken));
}

function requireService(c: any): Response | null {
  if (isServiceAuthorized(c)) {
    return null;
  }
  return c.json({ error: 'Unauthorized' }, 401);
}

async function getAdminIdentity(c: any) {
  return authenticateBearerAdmin(c.req.header('Authorization'), ADMIN_AUTH_CONFIG)
    || await authenticateBasicAdmin(c.req.header('Authorization'), ADMIN_AUTH_CONFIG)
    || verifyAdminSession(getCookie(c, ADMIN_SESSION_COOKIE), ADMIN_AUTH_CONFIG);
}

async function requireAdmin(c: any): Promise<Response | null> {
  const identity = await getAdminIdentity(c);
  if (identity) {
    if (identity.strategy !== 'token' && !isSameOriginAdminRequest(c.req.raw)) {
      return c.json({ error: 'Cross-origin admin request rejected' }, 403);
    }
    return null;
  }
  return c.json({ error: 'Unauthorized' }, 401);
}

function setAdminResponseHeaders(c: any) {
  c.header('Cache-Control', 'no-store');
  c.header('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
}

function isSecureRequest(c: any): boolean {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('X-Forwarded-Proto') === 'https';
}

function setAdminSessionCookie(c: any, session: string) {
  setCookie(c, ADMIN_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c),
    path: '/admin',
    maxAge: ADMIN_AUTH_CONFIG.sessionTtlSeconds,
  });
}

function clearAdminCookies(c: any) {
  deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/admin' });
  deleteCookie(c, ADMIN_OAUTH_STATE_COOKIE, { path: '/admin/auth/google' });
}

function sendX402Result(c: any, result: X402HttpResult): Response {
  for (const [name, value] of Object.entries(result.headers || {})) {
    c.header(name, value);
  }
  c.header('Cache-Control', result.status >= 200 && result.status < 300 ? 'private, no-store' : 'no-store');
  return c.json(result.body, result.status as any);
}

async function readX402JsonBody(c: any, maxBytes: number): Promise<{ body?: unknown; error?: Response }> {
  const parsed = await readBoundedJsonBody(c.req.raw, maxBytes);
  if (!parsed.error) return { body: parsed.body };
  c.header('Cache-Control', 'no-store');
  return parsed.error === 'too_large'
    ? { error: c.json({ error: 'Request body is too large' }, 413) }
    : { error: c.json({ error: 'Malformed JSON request body' }, 400) };
}

async function authenticateClient(c: any): Promise<{
  identity?: { clientId: string; clientName: string; allowedClusters: string[] | null };
  response?: Response;
}> {
  const credential = getBearerCredential(c);

  if (!credential) {
    return { response: c.json({ error: 'Missing credentials. Use: Bearer clientId:clientSecret' }, 401) };
  }

  const separatorIndex = credential.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === credential.length - 1) {
    return { response: c.json({ error: 'Invalid credentials format. Use: Bearer clientId:clientSecret' }, 401) };
  }

  const clientId = credential.slice(0, separatorIndex);
  const clientSecret = credential.slice(separatorIndex + 1);
  const valid = await ClientService.validateCredentials(clientId, clientSecret);

  if (!valid) {
    return { response: c.json({ error: 'Invalid credentials' }, 401) };
  }

  const client = await ClientService.getClient(clientId);
  if (!client || !client.active || (client.allowedClusters !== null
    && (!Array.isArray(client.allowedClusters)
      || client.allowedClusters.some((cluster) => typeof cluster !== 'string')))) {
    return { response: c.json({ error: 'Invalid credentials' }, 401) };
  }
  return {
    identity: {
      clientId,
      clientName: client.name,
      allowedClusters: client.allowedClusters,
    },
  };
}

function readRequestedSessionId(body: any): string | undefined {
  if (!body || typeof body !== 'object' || !('sessionId' in body)) {
    return undefined;
  }
  if (typeof body.sessionId !== 'string') {
    return '';
  }
  return body.sessionId.trim();
}

function validateAllowedClusters(value: unknown): { value?: string[] | null; error?: string } {
  if (value === undefined || value === null) return { value: null };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return { error: 'allowedClusters must be null or an array of cluster names' };
  }
  const clusters = [...new Set(value.map((entry) => entry.trim()))];
  const routable = new Set(ControlPlaneConfig.regions
    .filter((region) => !region.x402Only)
    .map((region) => region.clusterName));
  const unknown = clusters.find((cluster) => !routable.has(cluster));
  if (unknown) return { error: `Unknown or reserved cluster: ${unknown}` };
  return { value: clusters };
}

function isReservedClient(clientId: string): boolean {
  return clientId === ADMIN_CLIENT_ID || clientId === X402_PUBLIC_CLIENT_ID;
}

function readClusterAccessForm(form: FormData): { value?: string[] | null; error?: string } {
  const mode = String(form.get('clusterAccessMode') || 'selected');
  if (mode === 'selected') {
    return validateAllowedClusters(form.getAll('allowedClusters').map((value) => String(value)));
  }
  if (mode === 'all') {
    if (form.get('confirmAllClusters') !== 'yes') {
      return { error: 'Confirm unrestricted access before granting all normal clusters.' };
    }
    return { value: null };
  }
  return { error: 'Choose selected clusters or explicitly choose all normal clusters.' };
}

function clientClusterOptions() {
  const options = new Map<string, { clusterName: string; regionName: string; enabled: boolean }>();
  for (const region of ControlPlaneConfig.regions) {
    if (region.x402Only || options.has(region.clusterName)) continue;
    options.set(region.clusterName, {
      clusterName: region.clusterName,
      regionName: region.name,
      enabled: region.enabled,
    });
  }
  return [...options.values()];
}

function readSessionExpiresAt(session: { metadata?: unknown } | null | undefined): string | undefined {
  const metadata = session?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const expiresAt = (metadata as Record<string, unknown>).expiresAt;
  return typeof expiresAt === 'string' && expiresAt.trim() ? expiresAt : undefined;
}

function readSessionMetadata(session: { metadata?: unknown } | null | undefined): Record<string, unknown> | null {
  const metadata = session?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : null;
}

function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

async function generateSessionId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionId = crypto.randomUUID().slice(0, 8);
    const existing = await SessionService.getSession(sessionId);
    if (!existing.length) {
      return sessionId;
    }
  }
  return crypto.randomUUID();
}

function findRegion(name: string | null | undefined) {
  if (!name) {
    return null;
  }
  return ControlPlaneConfig.regions.find((region) => region.name === name) || null;
}

function findUniqueRegionByCluster(clusterName: string | null | undefined) {
  if (!clusterName) {
    return null;
  }
  const matches = ControlPlaneConfig.regions.filter((region) => region.clusterName === clusterName || region.name === clusterName);
  return matches.length === 1 ? matches[0] : null;
}

function resolveSessionRegion(session: { region?: string | null; clusterName?: string | null } | null | undefined) {
  return findRegion(session?.region) || findUniqueRegionByCluster(session?.clusterName);
}

async function deleteRoutedSession(sessionId: string, clientId?: string) {
  const [session] = await SessionService.getSession(sessionId);
  const region = resolveSessionRegion(session);

  if (!session) {
    return {
      status: 404,
      body: { success: false, error: 'Session not found' },
    };
  }

  if (clientId && session.clientId !== clientId) {
    return {
      status: 404,
      body: { success: false, error: 'Session not found' },
    };
  }

  if (!region) {
    return {
      status: 409,
      body: { success: false, error: 'Session region is not configured' },
    };
  }

  let remoteDelete;
  try {
    remoteDelete = await deleteRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken);
  } catch (error) {
    return {
      status: 502,
      body: {
        success: false,
        error: 'Failed to contact regional pool manager',
        details: (error as Error).message,
      },
    };
  }

  if (!remoteDelete.response.ok && remoteDelete.response.status !== 404) {
    return {
      status: 502,
      body: {
        success: false,
        error: 'Regional pool manager failed to delete session',
        region: region.name,
        statusCode: remoteDelete.response.status,
        details: remoteDelete.body,
      },
    };
  }

  if (session) {
    await SessionService.endSession(sessionId, 'deleted');
  }

  return {
    status: 200,
    body: {
      success: true,
      region: region.name,
      localRecordUpdated: Boolean(session),
      regionalStatusCode: remoteDelete.response.status,
    },
  };
}

async function getRoutedSession(sessionId: string, clientId?: string) {
  const [session] = await SessionService.getSession(sessionId);

  if (!session) {
    return {
      status: 404,
      body: { success: false, error: 'Session not found' },
    };
  }

  if (clientId && session.clientId !== clientId) {
    return {
      status: 404,
      body: { success: false, error: 'Session not found' },
    };
  }

  const region = resolveSessionRegion(session);
  if (!region) {
    return {
      status: 409,
      body: { success: false, error: 'Session region is not configured' },
    };
  }

  let remote;
  try {
    remote = await getRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken);
  } catch (error) {
    return {
      status: 502,
      body: {
        success: false,
        error: 'Failed to contact regional pool manager',
        details: (error as Error).message,
      },
    };
  }

  if (!remote.response.ok) {
    return {
      status: remote.response.status,
      body: remote.body || { success: false, error: 'Session not found in region' },
    };
  }

  return {
    status: 200,
    body: { ...remote.body, region: region.name, clusterName: region.clusterName },
  };
}

async function routeSession(
  identity: { clientId: string; clientName: string; allowedClusters: string[] | null },
  body: any,
): Promise<{ status: number; body: any }> {
  const requestReceivedAt = new Date();
  const requestedSessionId = readRequestedSessionId(body);
  if (requestedSessionId === '') {
    return { status: 400, body: { error: 'Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-].' } };
  }
  if (requestedSessionId && !isValidSessionId(requestedSessionId)) {
    return { status: 400, body: { error: 'Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-].' } };
  }

  const ttlSeconds = readOptionalSeconds(body, 'ttlSeconds');
  const ttlError = validateTtlSeconds(ttlSeconds, ControlPlaneConfig.sessionMaxTtlSeconds, 'ttlSeconds');
  if (ttlError) {
    return { status: 400, body: { error: ttlError } };
  }
  const expiresAt = ttlSeconds ? expiresAtFromTtlSeconds(ttlSeconds) : undefined;
  const proxy = body?.proxy;
  if (proxy !== undefined && proxy !== null && proxy !== false
    && (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)
      || Object.keys(proxy).length !== 1 || typeof proxy.country !== 'string'
      || !ISO_COUNTRY_CODES.has(proxy.country.trim()))) {
    return { status: 400, body: { error: 'proxy must be false or { country: "US" } using an ISO 3166-1 alpha-2 country code' } };
  }

  const selection = selectRegions(ControlPlaneConfig.regions, body?.regions, identity.allowedClusters);
  if (selection.error) {
    return {
      status: selection.error.startsWith('Client is not allowed') ? 403 : 400,
      body: { error: selection.error },
    };
  }
  if (!selection.regions.length) {
    return identity.allowedClusters === null
      ? { status: 503, body: { error: 'No enabled regions are configured' } }
      : { status: 403, body: { error: 'This client has no accessible clusters' } };
  }

  const sessionId = requestedSessionId || await generateSessionId();
  const existing = await SessionService.getSession(sessionId);
  if (existing.length) {
    return { status: 409, body: { error: 'Session ID already exists' } };
  }

  const attempts = [];
  for (const region of selection.regions) {
    const result = await allocateInRegion(region, {
      sessionId,
      clientId: identity.clientId,
      clientName: identity.clientName,
      expiresAt,
      ...(proxy && typeof proxy === 'object' ? { proxy: { country: proxy.country.trim() } } : {}),
    }, ControlPlaneConfig.serviceAuthToken);
    attempts.push(result.attempt);

    if (!result.session) {
      continue;
    }

    try {
      const allocatedAt = new Date();
      const analyticsMetadata = buildSessionAnalyticsMetadata({
        requestReceivedAt,
        allocatedAt,
        attempts,
        regionalSession: result.session,
      });
      await SessionService.createSession(
        sessionId,
        identity.clientId,
        identity.clientName,
        region.clusterName,
        region.name,
        {
          ...(expiresAt ? { expiresAt } : {}),
          ...analyticsMetadata,
        },
      );
      console.log(JSON.stringify(buildSessionAllocationEvent({
        sessionId,
        clientId: identity.clientId,
        requestReceivedAt,
        completedAt: allocatedAt,
        outcome: 'success',
        attempts,
        region: region.name,
      })));
      return { status: 200, body: { ...result.session, attempts } };
    } catch (error) {
      await deleteRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken).catch(() => null);
      console.error('❌ Error recording routed session:', error);
      return { status: 500, body: { error: 'Session allocated but failed to record in control plane' } };
    }
  }

  console.warn(JSON.stringify(buildSessionAllocationEvent({
    sessionId,
    clientId: identity.clientId,
    requestReceivedAt,
    completedAt: new Date(),
    outcome: 'failed',
    attempts,
  })));
  return { status: 503, body: { error: 'No requested region could allocate a session', attempts } };
}

async function extendRoutedSessionTtl(sessionId: string, body: any, clientId?: string) {
  const [session] = await SessionService.getSession(sessionId);

  if (!session) {
    return {
      status: 404,
      body: { success: false, error: 'Session not found' },
    };
  }

  if (clientId && session.clientId !== clientId) {
    return {
      status: 404,
      body: { success: false, error: 'Session not found' },
    };
  }

  if (session.status !== 'active') {
    return {
      status: 409,
      body: { success: false, error: 'Session is not active' },
    };
  }

  const region = resolveSessionRegion(session);
  if (!region) {
    return {
      status: 409,
      body: { success: false, error: 'Session region is not configured' },
    };
  }

  const extendBySeconds = readOptionalSeconds(body, 'extendBySeconds');
  const ttlError = validateTtlSeconds(extendBySeconds, ControlPlaneConfig.sessionMaxTtlSeconds, 'extendBySeconds');
  if (ttlError || !extendBySeconds) {
    return { status: 400, body: { success: false, error: ttlError || 'extendBySeconds must be a positive integer' } };
  }

  const currentExpiresAt = readSessionExpiresAt(session);
  const now = new Date();
  const expiresAt = extendExpiresAt(currentExpiresAt, extendBySeconds, now);
  if (Date.parse(expiresAt) > now.getTime() + ControlPlaneConfig.sessionMaxTtlSeconds * 1000) {
    return {
      status: 400,
      body: {
        success: false,
        error: `Requested extension would exceed the maximum TTL of ${ControlPlaneConfig.sessionMaxTtlSeconds} seconds`,
      },
    };
  }

  const previousMetadata = readSessionMetadata(session);
  try {
    await SessionService.updateSessionMetadata(sessionId, {
      ...(previousMetadata || {}),
      expiresAt,
    });
  } catch (error) {
    console.error('❌ Error recording session TTL extension:', error);
    return {
      status: 500,
      body: { success: false, error: 'Failed to record session TTL extension' },
    };
  }

  let remoteUpdate;
  try {
    remoteUpdate = await extendRegionalSessionTtl(region, sessionId, expiresAt, ControlPlaneConfig.serviceAuthToken);
  } catch (error) {
    await SessionService.updateSessionMetadata(sessionId, previousMetadata).catch((rollbackError) => {
      console.error('❌ Failed to roll back session TTL metadata:', rollbackError);
    });
    return {
      status: 502,
      body: {
        success: false,
        error: 'Failed to contact regional pool manager',
        details: (error as Error).message,
      },
    };
  }

  if (!remoteUpdate.response.ok) {
    await SessionService.updateSessionMetadata(sessionId, previousMetadata).catch((rollbackError) => {
      console.error('❌ Failed to roll back session TTL metadata:', rollbackError);
    });
    return {
      status: 502,
      body: {
        success: false,
        error: 'Regional pool manager failed to extend session TTL',
        region: region.name,
        statusCode: remoteUpdate.response.status,
        details: remoteUpdate.body,
      },
    };
  }

  return {
    status: 200,
    body: {
      ...remoteUpdate.body,
      expiresAt,
      region: region.name,
      clusterName: region.clusterName,
    },
  };
}

async function createRoutedSession(
  c: any,
  identity: { clientId: string; clientName: string; allowedClusters: string[] | null },
  body: any,
) {
  const result = await routeSession(identity, body);
  return c.json(result.body, result.status as any);
}

function readPagination(c: any) {
  const requestedLimit = Number(c.req.query('limit') || '10');
  const requestedOffset = Number(c.req.query('offset') || '0');
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 10;
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  return { limit, offset };
}

async function listSessionPage(c: any, clientId?: string) {
  const { limit, offset } = readPagination(c);
  const rows = await SessionService.listSessions(limit + 1, clientId || undefined, offset);
  const hasMore = rows.length > limit;
  return {
    sessions: hasMore ? rows.slice(0, limit) : rows,
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    },
  };
}

async function loadAdminRegions(): Promise<AdminRegion[]> {
  return Promise.all(ControlPlaneConfig.regions.map(async (region) => {
    if (!region.enabled) {
      return toAdminRegion(region, false, { error: 'disabled' });
    }

    const { response, body } = await getRegionalServers(region, ControlPlaneConfig.serviceAuthToken).catch((error) => ({
      response: null,
      body: { error: (error as Error).message },
    }));
    return toAdminRegion(region, !!response?.ok, body);
  }));
}

function normalizeWindowHours(raw: string | number | undefined): number {
  const value = Number(raw ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.min(720, value) : 1;
}

// Pick a trend-chart bucket count so longer ranges keep useful granularity
// without over-crowding the x-axis (getSessionTimeSeries caps at 48).
function bucketsForWindow(windowHours: number): number {
  if (windowHours <= 24) return 12;   // 1h→5m, 6h→30m, 24h→2h
  if (windowHours <= 72) return 12;   // 2d→4h, 3d→6h
  if (windowHours <= 168) return 14;  // 7d→12h
  if (windowHours <= 336) return 14;  // 14d→1d
  return 15;                          // 30d→2d
}

// Combines live Agones gauges (via pool managers) with cumulative Postgres
// session stats into a single payload shared by the API and the admin UI.
// USDC and the other supported x402 settlement assets use 6 decimals; the
// client flow assumes the same. The atomic ledger stays the source of truth.
const X402_ASSET_DECIMALS = 6;

async function buildX402AnalyticsPayload(windowHours: number): Promise<X402AnalyticsData | undefined> {
  if (!ControlPlaneConfig.x402.enabled) return undefined;
  const analytics = await getX402Analytics(windowHours, ControlPlaneConfig.x402.blockSeconds);
  return {
    ...analytics,
    assetName: ControlPlaneConfig.x402.paymentAssetName,
    assetDecimals: X402_ASSET_DECIMALS,
    network: ControlPlaneConfig.x402.network,
    testnet: ControlPlaneConfig.x402.network === 'eip155:84532',
  };
}

async function buildStatsPayload(windowHours: number): Promise<AnalyticsData> {
  const [regions, windowStats, allocationStats, activeSessions, staleActiveSessions, series, regionSessions, topClients] = await Promise.all([
    loadAdminRegions(),
    getSessionWindowStats(windowHours),
    getSessionAllocationStats(windowHours),
    getActiveSessionCount(),
    getStaleActiveSessionCount(),
    getSessionTimeSeries(windowHours, bucketsForWindow(windowHours)),
    getSessionsByRegion(windowHours),
    getTopClients(windowHours),
  ]);

  const enabledRegions = regions.filter((region) => region.enabled);
  const servers = enabledRegions.flatMap((region) => region.servers || []);
  const allocated = servers.filter((server) => server.status === 'Allocated').length;
  const ready = servers.filter((server) => server.status === 'Ready').length;
  const capacity = servers.length;

  const sessionsByRegion = new Map(regionSessions.map((row) => [row.key, row.sessions]));
  const byRegion = enabledRegions.map((region) => {
    const regionServers = region.servers || [];
    return {
      region: region.name,
      allocated: regionServers.filter((server) => server.status === 'Allocated').length,
      capacity: regionServers.length,
      sessions: sessionsByRegion.get(region.name) ?? 0,
    };
  });

  const windowMinutes = windowHours * 60;
  const sessionsPerMinute = windowMinutes > 0
    ? Math.round((windowStats.created / windowMinutes) * 100) / 100
    : 0;

  return {
    windowHours,
    configuredTtlSeconds: ControlPlaneConfig.sessionMaxTtlSeconds,
    live: { allocated, ready, capacity, activeSessions, staleActiveSessions },
    throughput: { sessionsPerMinute },
    allocation: allocationStats,
    window: {
      created: windowStats.created,
      deleted: windowStats.deleted,
      expired: windowStats.expired,
      ended: windowStats.ended,
      avgDurationSeconds: windowStats.avgDurationSeconds,
      p50DurationSeconds: windowStats.p50DurationSeconds,
      p95DurationSeconds: windowStats.p95DurationSeconds,
      totalDurationSeconds: windowStats.totalDurationSeconds,
    },
    byRegion,
    topClients: topClients.map((row) => ({ clientName: row.key, sessions: row.sessions })),
    series,
  };
}

async function renderClientsPage(c: any, options: {
  selectedClientId?: string | null;
  secretNotice?: { clientId: string; clientSecret: string } | null;
  notice?: ActionNotice | null;
} = {}) {
  const clients = await ClientService.listClients();
  const selectedClientId = options.selectedClientId || c.req.query('clientId')?.trim() || null;
  const { sessions, pagination } = selectedClientId
    ? await listSessionPage(c, selectedClientId)
    : await listSessionPage(c, undefined);
  return c.html(await renderClientsViewHtml({
    clients,
    clusters: clientClusterOptions(),
    selectedClientId,
    sessions: selectedClientId ? sessions : [],
    pagination,
    secretNotice: options.secretNotice,
    notice: options.notice,
  }));
}

async function renderClustersPage(c: any, options: {
  selectedRegion?: string | null;
  notice?: ActionNotice | null;
} = {}) {
  const selectedRegion = options.selectedRegion || c.req.query('region')?.trim() || 'all';
  const regions = await loadAdminRegions();
  const safeSelectedRegion = selectedRegion === 'all' || regions.some((region) => region.name === selectedRegion)
    ? selectedRegion
    : 'all';
  return c.html(await renderClustersViewHtml({ regions, selectedRegion: safeSelectedRegion, notice: options.notice }));
}

app.get('/health', (c) => c.text('OK'));

app.get('/favicon.ico', async (c) => {
  c.header('Content-Type', 'image/x-icon');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(await Bun.file('./public/assets/favicon.ico').arrayBuffer());
});

app.use('/admin/*', async (c, next) => {
  setAdminResponseHeaders(c);
  if (isAdminAuthPath(new URL(c.req.url).pathname)) {
    return next();
  }

  const unauthorized = await requireAdmin(c);
  if (!unauthorized) {
    return next();
  }

  if (wantsHtml(c.req.raw.headers)) {
    return c.redirect('/admin/login', 302);
  }
  c.header('WWW-Authenticate', 'Basic realm="Popcorn Control Plane"');
  return unauthorized;
});

app.use('/v1/x402/*', async (c, next) => {
  if (!ControlPlaneConfig.x402.enabled) return next();
  const address = selectTrustedClientAddress(
    c.req.header('X-Forwarded-For'),
    c.req.header('X-Real-IP'),
    ControlPlaneConfig.x402.trustedProxyHops,
  );
  const key = `ip:${crypto.createHash('sha256').update(address).digest('hex')}`;
  let limit;
  try {
    limit = await X402Store.consumeRateLimit(key, ControlPlaneConfig.x402.rateLimitPerMinute);
  } catch (error) {
    console.error('x402 shared rate limiter unavailable:', error);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'x402 request admission is temporarily unavailable' }, 503);
  }
  c.header('X-RateLimit-Limit', String(ControlPlaneConfig.x402.rateLimitPerMinute));
  c.header('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfterSeconds));
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'x402 request rate limit exceeded' }, 429);
  }
  const now = Date.now();
  if (now - lastX402StaleCleanupAt >= 15 * 60 * 1000) {
    lastX402StaleCleanupAt = now;
    void X402Store.cleanupStaleState().catch((error) => {
      console.error('Failed to clean stale x402 state:', error);
    });
  }
  if (X402_CONTROLLER && now - lastX402ReconciliationAt >= 5 * 1000) {
    lastX402ReconciliationAt = now;
    void X402_CONTROLLER.reconcilePendingSettlements().catch((error) => {
      console.error('Failed to reconcile pending x402 settlements:', error);
    });
  }
  return next();
});

app.post('/v1/x402/sessions', async (c) => {
  if (!X402_CONTROLLER) return c.json({ error: 'x402 sessions are not enabled' }, 404);
  const parsed = await readX402JsonBody(c, 64);
  if (parsed.error) return parsed.error;
  const result = await X402_CONTROLLER.create({
    idempotencyKey: c.req.header('Idempotency-Key'),
    paymentSignature: c.req.header('PAYMENT-SIGNATURE'),
    resourceUrl: c.req.url,
  }, parsed.body);
  return sendX402Result(c, result);
});

app.post('/v1/x402/sessions/:id/extend', async (c) => {
  if (!X402_CONTROLLER) return c.json({ error: 'x402 sessions are not enabled' }, 404);
  const parsed = await readX402JsonBody(c, 128);
  if (parsed.error) return parsed.error;
  const result = await X402_CONTROLLER.extend(c.req.param('id'), {
    idempotencyKey: c.req.header('Idempotency-Key'),
    paymentSignature: c.req.header('PAYMENT-SIGNATURE'),
    resourceUrl: c.req.url,
  }, parsed.body);
  return sendX402Result(c, result);
});

app.get('/v1/x402/sessions/:id', async (c) => {
  if (!X402_CONTROLLER) return c.json({ error: 'x402 sessions are not enabled' }, 404);
  return sendX402Result(c, await X402_CONTROLLER.status(c.req.param('id')));
});

app.delete('/v1/x402/sessions/:id', async (c) => {
  if (!X402_CONTROLLER) return c.json({ error: 'x402 sessions are not enabled' }, 404);
  return sendX402Result(c, await X402_CONTROLLER.terminate(c.req.param('id')));
});

app.post('/v1/sessions', async (c) => {
  const auth = await authenticateClient(c);
  if (auth.response) {
    return auth.response;
  }
  const body = await c.req.json().catch(() => ({}));
  return createRoutedSession(c, auth.identity!, body);
});

app.get('/v1/session/:id', async (c) => {
  const auth = await authenticateClient(c);
  if (auth.response) {
    return auth.response;
  }

  const result = await getRoutedSession(c.req.param('id'), auth.identity!.clientId);
  return c.json(result.body, result.status as any);
});

app.delete('/v1/session/:id', async (c) => {
  const auth = await authenticateClient(c);
  if (auth.response) {
    return auth.response;
  }

  const result = await deleteRoutedSession(c.req.param('id'), auth.identity!.clientId);
  return c.json(result.body, result.status as any);
});

app.patch('/v1/session/:id/ttl', async (c) => {
  const auth = await authenticateClient(c);
  if (auth.response) {
    return auth.response;
  }

  const body = await c.req.json().catch(() => ({}));
  const result = await extendRoutedSessionTtl(c.req.param('id'), body, auth.identity!.clientId);
  return c.json(result.body, result.status as any);
});

app.get('/admin/login', async (c) => c.html(await Bun.file('./public/admin-login.html').text()));

app.get('/admin/assets/admin.css', async (c) => {
  c.header('Content-Type', 'text/css; charset=utf-8');
  return c.body(await Bun.file('./public/admin.css').text());
});

const ADMIN_ASSETS = {
  'site-icon.svg': { path: './public/assets/site-icon.svg', contentType: 'image/svg+xml' },
  'favicon-32.png': { path: './public/assets/favicon-32.png', contentType: 'image/png' },
  'apple-touch-icon.png': { path: './public/assets/apple-touch-icon.png', contentType: 'image/png' },
  'site-icon-192.png': { path: './public/assets/site-icon-192.png', contentType: 'image/png' },
  'site-icon-512.png': { path: './public/assets/site-icon-512.png', contentType: 'image/png' },
  'site.webmanifest': { path: './public/assets/site.webmanifest', contentType: 'application/manifest+json' },
} as const;

app.get('/admin/assets/:filename', async (c) => {
  const filename = c.req.param('filename') as keyof typeof ADMIN_ASSETS;
  const asset = ADMIN_ASSETS[filename];
  if (!asset) return c.notFound();
  c.header('Content-Type', asset.contentType);
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(await Bun.file(asset.path).arrayBuffer());
});

app.get('/admin/auth/config', (c) => {
  return c.json({
    password: isPasswordLoginConfigured(ADMIN_AUTH_CONFIG),
    google: isGoogleOAuthConfigured(ADMIN_AUTH_CONFIG),
  });
});

app.post('/admin/auth/password', async (c) => {
  const form = await c.req.formData();
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');

  if (!await verifyAdminPassword(username, password, ADMIN_AUTH_CONFIG)) {
    return c.redirect('/admin/login?error=Invalid%20credentials', 302);
  }

  if (!isPasswordLoginConfigured(ADMIN_AUTH_CONFIG)) {
    return c.redirect('/admin/login?error=Admin%20session%20secret%20is%20not%20configured', 302);
  }

  setAdminSessionCookie(c, createAdminSession({
    id: username,
    displayName: username,
    strategy: 'password',
  }, ADMIN_AUTH_CONFIG));
  return c.redirect('/admin', 302);
});

app.post('/admin/login', async (c) => {
  return c.redirect('/admin/auth/password', 307);
});

app.get('/admin/auth/google', (c) => {
  if (!isGoogleOAuthConfigured(ADMIN_AUTH_CONFIG)) {
    return c.redirect('/admin/login?error=Google%20OAuth%20is%20not%20configured', 302);
  }

  const state = createOauthState(ADMIN_AUTH_CONFIG);
  setCookie(c, ADMIN_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c),
    path: '/admin/auth/google',
    maxAge: 5 * 60,
  });

  return c.redirect(buildGoogleAuthorizationUrl(ADMIN_AUTH_CONFIG, state), 302);
});

app.get('/admin/auth/google/callback', async (c) => {
  if (!verifyOauthState(c.req.query('state'), getCookie(c, ADMIN_OAUTH_STATE_COOKIE), ADMIN_AUTH_CONFIG)) {
    return c.redirect('/admin/login?error=Invalid%20OAuth%20state', 302);
  }

  const code = c.req.query('code');
  if (!code) {
    return c.redirect('/admin/login?error=Missing%20OAuth%20code', 302);
  }

  try {
    const userInfo = await fetchGoogleUserInfo(code, ADMIN_AUTH_CONFIG);
    const identity = authorizeGoogleUser(userInfo, ADMIN_AUTH_CONFIG);
    if (!identity) {
      return c.redirect('/admin/login?error=Google%20account%20is%20not%20allowed', 302);
    }

    setAdminSessionCookie(c, createAdminSession(identity, ADMIN_AUTH_CONFIG));
    deleteCookie(c, ADMIN_OAUTH_STATE_COOKIE, { path: '/admin/auth/google' });
    return c.redirect('/admin', 302);
  } catch (error) {
    console.error('Google admin login failed:', error);
    return c.redirect('/admin/login?error=Google%20login%20failed', 302);
  }
});

app.post('/admin/logout', (c) => {
  clearAdminCookies(c);
  return c.redirect('/admin/login', 302);
});

app.get('/admin', async (c) => {
  setAdminResponseHeaders(c);
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return c.redirect('/admin/login', 302);
  return c.redirect('/admin/analytics', 302);
});

app.get('/admin/clusters', async (c) => {
  const region = c.req.query('region');
  const fragmentPath = region
    ? `/admin/ui/clusters?region=${encodeURIComponent(region)}`
    : '/admin/ui/clusters';
  return c.html(await renderShellHtml('clusters', fragmentPath));
});

app.get('/admin/analytics', async (c) => {
  return c.html(await renderShellHtml('analytics'));
});

app.get('/admin/ui/clients', async (c) => {
  return renderClientsPage(c);
});

app.post('/admin/ui/clients', async (c) => {
  try {
    const form = await c.req.formData();
    const name = String(form.get('name') || '').trim();
    if (!name) {
      return renderClientsPage(c, {
        notice: { tone: 'error', title: 'Client not created', message: 'Client name is required.' },
      });
    }

    const acl = readClusterAccessForm(form);
    if (acl.error) {
      return renderClientsPage(c, {
        notice: { tone: 'error', title: 'Client not created', message: acl.error },
      });
    }

    const credentials = await ClientService.createClient(name, acl.value!);
    return renderClientsPage(c, {
      selectedClientId: credentials.clientId,
      secretNotice: credentials,
    });
  } catch (error) {
    console.error('❌ Error creating client from UI:', error);
    return renderClientsPage(c, {
      notice: { tone: 'error', title: 'Client not created', message: 'Internal server error.' },
    });
  }
});

app.patch('/admin/ui/clients/:id/access', async (c) => {
  const clientId = c.req.param('id');
  if (isReservedClient(clientId)) {
    return renderClientsPage(c, {
      selectedClientId: clientId,
      notice: { tone: 'error', title: 'Access not changed', message: 'Built-in system client access cannot be modified.' },
    });
  }

  try {
    const acl = readClusterAccessForm(await c.req.formData());
    if (acl.error) {
      return renderClientsPage(c, {
        selectedClientId: clientId,
        notice: { tone: 'error', title: 'Access not changed', message: acl.error },
      });
    }
    const updated = await ClientService.updateAllowedClusters(clientId, acl.value!);
    if (!updated) {
      return renderClientsPage(c, {
        notice: { tone: 'error', title: 'Access not changed', message: `Client ${clientId} was not found.` },
      });
    }
    const access = acl.value === null
      ? 'all current and future normal clusters'
      : acl.value!.length
        ? `${acl.value!.length} selected cluster${acl.value!.length === 1 ? '' : 's'}`
        : 'no clusters';
    return renderClientsPage(c, {
      selectedClientId: clientId,
      notice: { tone: 'success', title: 'Cluster access updated', message: `Client ${clientId} now has access to ${access}.` },
    });
  } catch (error) {
    console.error('Error updating client cluster access from UI:', error);
    return renderClientsPage(c, {
      selectedClientId: clientId,
      notice: { tone: 'error', title: 'Access not changed', message: 'Internal server error.' },
    });
  }
});

app.delete('/admin/ui/clients/:id', async (c) => {
  const clientId = c.req.param('id');
  if (isReservedClient(clientId)) {
    return renderClientsPage(c, {
      selectedClientId: clientId,
      notice: { tone: 'error', title: 'Client not revoked', message: 'Built-in system clients cannot be revoked.' },
    });
  }
  await ClientService.revokeClient(clientId);
  return renderClientsPage(c, {
    selectedClientId: clientId,
    notice: { tone: 'success', title: 'Client revoked', message: `Client ${clientId} has been revoked.` },
  });
});

app.delete('/admin/ui/clients/:id/delete', async (c) => {
  const clientId = c.req.param('id');
  if (clientId === ADMIN_CLIENT_ID || clientId === X402_PUBLIC_CLIENT_ID) {
    return renderClientsPage(c, {
      selectedClientId: clientId,
      notice: { tone: 'error', title: 'Client not deleted', message: 'Built-in system clients cannot be deleted.' },
    });
  }

  const sessionCount = await SessionService.countSessionsForClient(clientId);
  if (sessionCount > 0) {
    return renderClientsPage(c, {
      selectedClientId: clientId,
      notice: {
        tone: 'error',
        title: 'Client not deleted',
        message: `Client ${clientId} has ${sessionCount} session record${sessionCount === 1 ? '' : 's'}. Revoke it to disable access while preserving analytics history.`,
      },
    });
  }

  await ClientService.deleteClient(clientId);
  return renderClientsPage(c, {
    notice: { tone: 'success', title: 'Client deleted', message: `Client ${clientId} has been permanently deleted.` },
  });
});

app.get('/admin/ui/client-sessions', async (c) => {
  const clientId = c.req.query('clientId')?.trim();
  const client = clientId ? await ClientService.getClient(clientId) : null;
  const { sessions, pagination } = clientId
    ? await listSessionPage(c, clientId)
    : await listSessionPage(c, undefined);
  return c.html(await renderClientSessionsPanelHtml({
    client,
    sessions: clientId ? sessions : [],
    pagination,
  }));
});

app.get('/admin/ui/clusters', async (c) => {
  return renderClustersPage(c);
});

app.get('/admin/ui/analytics', async (c) => {
  const windowHours = normalizeWindowHours(c.req.query('windowHours') ?? undefined);
  const scope: AnalyticsScope = c.req.query('scope') === 'x402' ? 'x402' : 'fleet';
  const [data, x402] = await Promise.all([
    buildStatsPayload(windowHours),
    buildX402AnalyticsPayload(windowHours),
  ]);
  return c.html(await renderAnalyticsViewHtml({ data, x402, scope }));
});

app.post('/admin/ui/sessions', async (c) => {
  const form = await c.req.formData();
  const region = String(form.get('region') || '').trim();
  const sessionId = String(form.get('sessionId') || '').trim();
  const result = await routeSession({ clientId: ADMIN_CLIENT_ID, clientName: ADMIN_CLIENT_NAME, allowedClusters: null }, {
    regions: region ? [region] : undefined,
    sessionId: sessionId || undefined,
  });
  const notice: ActionNotice = result.status >= 200 && result.status < 300
    ? {
      tone: 'success',
      title: 'Pod created',
      message: `Created ${result.body.sessionId} in ${result.body.region}.`,
      href: result.body.url,
    }
    : {
      tone: 'error',
      title: 'Pod not created',
      message: result.body.error || 'No requested region could allocate a session.',
    };
  return renderClustersPage(c, { selectedRegion: region || undefined, notice });
});

app.get('/admin/ui/session/:id/open', async (c) => {
  const sessionId = c.req.param('id');
  const [session] = await SessionService.getSession(sessionId);
  if (!session) {
    return c.text('Session not found', 404);
  }

  const region = resolveSessionRegion(session);
  if (!region) {
    return c.text('Session region is not configured', 404);
  }

  const { response, body } = await getRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken);
  if (!response.ok || !body?.url) {
    return c.text(body?.error || 'Session not found in region', response.status as any);
  }

  return c.redirect(body.url, 302);
});

app.delete('/admin/ui/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const result = await deleteRoutedSession(sessionId);
  const success = result.status >= 200 && result.status < 300;
  const notice: ActionNotice = success
    ? { tone: 'success', title: 'Session deleted', message: `Session ${sessionId} has been deleted.` }
    : { tone: 'error', title: 'Session not deleted', message: result.body.error || 'Failed to delete session.' };

  const refresh = c.req.query('refresh') || '/admin/ui/clusters';
  if (refresh.startsWith('/admin/ui/clients')) {
    const url = new URL(`http://local${refresh}`);
    const selectedClientId = url.searchParams.get('clientId');
    return renderClientsPage(c, {
      selectedClientId,
      notice,
    });
  }
  return renderClustersPage(c, {
    selectedRegion: new URL(`http://local${refresh}`).searchParams.get('region') || undefined,
    notice,
  });
});

app.get('/admin/regions', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  const regions = await loadAdminRegions();

  return c.json({ regions });
});

app.get('/admin/x402/analytics', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;
  return c.json(await getX402Analytics(
    normalizeWindowHours(c.req.query('windowHours') ?? 24),
    ControlPlaneConfig.x402.blockSeconds,
  ));
});

app.get('/admin/sessions', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;
  const requestedLimit = Number(c.req.query('limit') || '25');
  const requestedOffset = Number(c.req.query('offset') || '0');
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 25;
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  const clientId = c.req.query('clientId')?.trim();
  const rows = await SessionService.listSessions(limit + 1, clientId || undefined, offset);
  const hasMore = rows.length > limit;
  return c.json({
    sessions: hasMore ? rows.slice(0, limit) : rows,
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    },
  });
});

app.post('/admin/sessions', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;
  const body = await c.req.json().catch(() => ({}));
  return createRoutedSession(c, { clientId: ADMIN_CLIENT_ID, clientName: ADMIN_CLIENT_NAME, allowedClusters: null }, body);
});

app.get('/admin/session/:id', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  const sessionId = c.req.param('id');
  const [session] = await SessionService.getSession(sessionId);
  if (!session) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  const region = resolveSessionRegion(session);
  if (!region) {
    return c.json({ success: false, error: 'Session region is not configured' }, 404);
  }

  const { response, body } = await getRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken);
  if (!response.ok) {
    return c.json(body || { error: 'Session not found in region' }, response.status as any);
  }
  return c.json({ ...body, region: region.name, clusterName: region.clusterName });
});

app.delete('/admin/session/:id', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  const result = await deleteRoutedSession(c.req.param('id'));
  return c.json(result.body, result.status as any);
});

app.patch('/admin/session/:id/ttl', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  const body = await c.req.json().catch(() => ({}));
  const result = await extendRoutedSessionTtl(c.req.param('id'), body);
  return c.json(result.body, result.status as any);
});

// TTL controller callback for expired regional sessions.
app.post('/sessions/:id/end', async (c) => {
  const unauthorized = requireService(c);
  if (unauthorized) {
    console.warn('⚠️ Unauthorized session end attempt');
    return unauthorized;
  }

  try {
    const sessionId = c.req.param('id');
    const { status, gameServerName } = await c.req.json();

    if (!status || (status !== 'deleted' && status !== 'expired')) {
      return c.json({ error: 'Invalid status. Must be "deleted" or "expired"' }, 400);
    }

    const [session] = await SessionService.getSession(sessionId);
    const changed = session?.clientId === X402_PUBLIC_CLIENT_ID
      ? typeof gameServerName === 'string' && gameServerName.length > 0
        ? await SessionService.endSessionIfCurrentWorkload(sessionId, status, gameServerName)
        : false
      : await SessionService.endSession(sessionId, status);
    if (changed && session?.clientId === 'x402-public') {
      await X402Store.addEvent({
        sessionId,
        eventType: status === 'expired' ? 'x402.session_expired' : 'x402.session_terminated',
        metadata: { source: 'regional_ttl_callback' },
      }).catch((error) => console.error('Failed to record x402 lifecycle analytics:', error));
    }
    return c.json({
      success: true,
      changed,
      ...(session?.clientId === X402_PUBLIC_CLIENT_ID && !changed ? { staleWorkload: true } : {}),
    });
  } catch (error) {
    console.error('❌ Error ending session:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/admin/clients', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  if (wantsHtml(c.req.raw.headers)) {
    return c.html(await renderShellHtml('clients'));
  }

  try {
    return c.json({ clients: await ClientService.listClients() });
  } catch (error) {
    console.error('❌ Error listing clients:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/admin/clients', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const { name, allowedClusters } = await c.req.json();

    if (!name) {
      return c.json({ error: 'Missing client name' }, 400);
    }

    const acl = validateAllowedClusters(allowedClusters === undefined ? [] : allowedClusters);
    if (acl.error) return c.json({ error: acl.error }, 400);
    const credentials = await ClientService.createClient(name, acl.value!);
    return c.json({
      success: true,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      message: 'IMPORTANT: Save the client secret securely. It will not be shown again.'
    });
  } catch (error) {
    console.error('❌ Error creating client:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.patch('/admin/clients/:id', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;
  try {
    if (isReservedClient(c.req.param('id'))) {
      return c.json({ error: 'Built-in system client access cannot be modified' }, 400);
    }
    const body = await c.req.json();
    if (!Object.prototype.hasOwnProperty.call(body, 'allowedClusters')) {
      return c.json({ error: 'allowedClusters is required' }, 400);
    }
    const acl = validateAllowedClusters(body.allowedClusters);
    if (acl.error) return c.json({ error: acl.error }, 400);
    const updated = await ClientService.updateAllowedClusters(c.req.param('id'), acl.value!);
    if (!updated) return c.json({ error: 'Client not found' }, 404);
    return c.json({ success: true, clientId: c.req.param('id'), allowedClusters: acl.value });
  } catch (error) {
    console.error('Error updating client cluster access:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.delete('/admin/clients/:id', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const clientId = c.req.param('id');
    if (isReservedClient(clientId)) {
      return c.json({ error: 'Built-in system clients cannot be revoked' }, 400);
    }
    await ClientService.revokeClient(clientId);
    return c.json({ success: true, message: `Client ${clientId} has been revoked` });
  } catch (error) {
    console.error('❌ Error revoking client:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.delete('/admin/clients/:id/delete', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const clientId = c.req.param('id');
    if (clientId === ADMIN_CLIENT_ID || clientId === X402_PUBLIC_CLIENT_ID) {
      return c.json({ error: 'Built-in system clients cannot be deleted' }, 400);
    }

    const sessionCount = await SessionService.countSessionsForClient(clientId);
    if (sessionCount > 0) {
      return c.json({
        error: `Client has ${sessionCount} session record${sessionCount === 1 ? '' : 's'} and cannot be hard-deleted`,
      }, 409);
    }

    await ClientService.deleteClient(clientId);
    return c.json({ success: true, message: `Client ${clientId} has been permanently deleted` });
  } catch (error) {
    console.error('❌ Error deleting client:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default {
  port: ControlPlaneConfig.port,
  fetch: app.fetch,
};
