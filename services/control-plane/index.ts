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
import { allocateInRegion, deleteRegionalSession, getRegionalServers, getRegionalSession } from './src/pool-manager';
import { selectRegions } from './src/regions';
import { SessionService } from './src/sessions';
import {
  renderClientSessionsPanelHtml,
  renderClientsViewHtml,
  renderClustersViewHtml,
  renderShellHtml,
  toAdminRegion,
  type ActionNotice,
  type AdminRegion,
} from './src/admin-ui';

const app = new Hono();
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ADMIN_CLIENT_ID = 'admin';
const ADMIN_CLIENT_NAME = 'Admin UI';
const ADMIN_AUTH_CONFIG = readAdminAuthConfig();

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

async function authenticateClient(c: any): Promise<{ identity?: { clientId: string; clientName: string }; response?: Response }> {
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
  return {
    identity: {
      clientId,
      clientName: client?.name || 'Unknown',
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

async function routeSession(identity: { clientId: string; clientName: string }, body: any): Promise<{ status: number; body: any }> {
  const requestedSessionId = readRequestedSessionId(body);
  if (requestedSessionId === '') {
    return { status: 400, body: { error: 'Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-].' } };
  }
  if (requestedSessionId && !isValidSessionId(requestedSessionId)) {
    return { status: 400, body: { error: 'Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-].' } };
  }

  const selection = selectRegions(ControlPlaneConfig.regions, body?.regions);
  if (selection.error) {
    return { status: 400, body: { error: selection.error } };
  }
  if (!selection.regions.length) {
    return { status: 503, body: { error: 'No enabled regions are configured' } };
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
    }, ControlPlaneConfig.serviceAuthToken);
    attempts.push(result.attempt);

    if (!result.session) {
      continue;
    }

    try {
      await SessionService.createSession(sessionId, identity.clientId, identity.clientName, region.clusterName, region.name);
      return { status: 200, body: { ...result.session, attempts } };
    } catch (error) {
      await deleteRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken).catch(() => null);
      console.error('❌ Error recording routed session:', error);
      return { status: 500, body: { error: 'Session allocated but failed to record in control plane' } };
    }
  }

  return { status: 503, body: { error: 'No requested region could allocate a session', attempts } };
}

async function createRoutedSession(c: any, identity: { clientId: string; clientName: string }, body: any) {
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

async function renderClientsPage(c: any, options: {
  selectedClientId?: string | null;
  secretNotice?: { clientId: string; clientSecret: string } | null;
  notice?: ActionNotice | null;
} = {}) {
  const clients = await ClientService.listClients();
  const selectedClientId = options.selectedClientId || c.req.query('clientId')?.trim() || clients[0]?.id || null;
  const { sessions, pagination } = selectedClientId
    ? await listSessionPage(c, selectedClientId)
    : await listSessionPage(c, undefined);
  return c.html(await renderClientsViewHtml({
    clients,
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

app.use('/admin/*', async (c, next) => {
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

app.post('/v1/sessions', async (c) => {
  const auth = await authenticateClient(c);
  if (auth.response) {
    return auth.response;
  }
  const body = await c.req.json().catch(() => ({}));
  return createRoutedSession(c, auth.identity!, body);
});

app.get('/admin/login', async (c) => c.html(await Bun.file('./public/admin-login.html').text()));

app.get('/admin/assets/admin.css', async (c) => {
  c.header('Content-Type', 'text/css; charset=utf-8');
  return c.body(await Bun.file('./public/admin.css').text());
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
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return c.redirect('/admin/login', 302);
  return c.html(await renderShellHtml());
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

    const credentials = await ClientService.createClient(name);
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

app.delete('/admin/ui/clients/:id', async (c) => {
  const clientId = c.req.param('id');
  await ClientService.revokeClient(clientId);
  return renderClientsPage(c, {
    selectedClientId: clientId,
    notice: { tone: 'success', title: 'Client revoked', message: `Client ${clientId} has been revoked.` },
  });
});

app.delete('/admin/ui/clients/:id/delete', async (c) => {
  const clientId = c.req.param('id');
  if (clientId === ADMIN_CLIENT_ID) {
    return renderClientsPage(c, {
      selectedClientId: clientId,
      notice: { tone: 'error', title: 'Client not deleted', message: 'The built-in admin client cannot be deleted.' },
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

app.post('/admin/ui/sessions', async (c) => {
  const form = await c.req.formData();
  const region = String(form.get('region') || '').trim();
  const sessionId = String(form.get('sessionId') || '').trim();
  const result = await routeSession({ clientId: ADMIN_CLIENT_ID, clientName: ADMIN_CLIENT_NAME }, {
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
  const [session] = await SessionService.getSession(sessionId);
  const region = resolveSessionRegion(session);
  if (region) {
    await deleteRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken);
  }
  await SessionService.endSession(sessionId, 'deleted');

  const refresh = c.req.query('refresh') || '/admin/ui/clusters';
  if (refresh.startsWith('/admin/ui/clients')) {
    const url = new URL(`http://local${refresh}`);
    const selectedClientId = url.searchParams.get('clientId');
    return renderClientsPage(c, {
      selectedClientId,
      notice: { tone: 'success', title: 'Session deleted', message: `Session ${sessionId} has been deleted.` },
    });
  }
  return renderClustersPage(c, {
    selectedRegion: new URL(`http://local${refresh}`).searchParams.get('region') || undefined,
    notice: { tone: 'success', title: 'Session deleted', message: `Session ${sessionId} has been deleted.` },
  });
});

app.get('/admin/regions', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  const regions = await loadAdminRegions();

  return c.json({ regions });
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
  return createRoutedSession(c, { clientId: ADMIN_CLIENT_ID, clientName: ADMIN_CLIENT_NAME }, body);
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

  const sessionId = c.req.param('id');
  const [session] = await SessionService.getSession(sessionId);
  const region = resolveSessionRegion(session);
  if (region) {
    await deleteRegionalSession(region, sessionId, ControlPlaneConfig.serviceAuthToken);
  }
  await SessionService.endSession(sessionId, 'deleted');
  return c.json({ success: true });
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
    const { status } = await c.req.json();

    if (!status || (status !== 'deleted' && status !== 'expired')) {
      return c.json({ error: 'Invalid status. Must be "deleted" or "expired"' }, 400);
    }

    await SessionService.endSession(sessionId, status);
    return c.json({ success: true });
  } catch (error) {
    console.error('❌ Error ending session:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/admin/clients', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

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
    const { name } = await c.req.json();

    if (!name) {
      return c.json({ error: 'Missing client name' }, 400);
    }

    const credentials = await ClientService.createClient(name);
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

app.delete('/admin/clients/:id', async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const clientId = c.req.param('id');
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
    if (clientId === ADMIN_CLIENT_ID) {
      return c.json({ error: 'The built-in admin client cannot be deleted' }, 400);
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
