import { Hono } from 'hono';
import { McpConfig } from './src/config';
import { credit } from './src/credits';
import { handleRpc, type JsonRpcRequest } from './src/mcp';
import {
  authorizationServerMetadata,
  issueAccessToken,
  newAuthorizationCode,
  protectedResourceMetadata,
  registerClient,
  subjectFor,
  verifyAccessToken,
  verifyChallenge,
} from './src/oauth';
import { InMemoryStore, type McpStore } from './src/store';
import { verifyWebhookSignature } from './src/stripe';

const store: McpStore = new InMemoryStore();
const app = new Hono();

app.get('/health', (c) => c.text('OK'));

/* ---------------------------------------------------------------- OAuth 2.1 */

app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata()));
app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata()));

app.post('/oauth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const registered = await registerClient(store, body);
  if ('error' in registered) return c.json({ error: 'invalid_client_metadata', error_description: registered.error }, 400);
  return c.json(
    {
      client_id: registered.clientId,
      client_name: registered.clientName,
      redirect_uris: registered.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    201,
  );
});

/**
 * Consent screen. Identity is intentionally pluggable: this reference build
 * asks the human for their Popcorn account identifier. Operators should
 * replace `renderConsent`/`/oauth/decision` with their own IdP (Google, WorkOS,
 * the Popcorn dashboard session) and keep the rest of the flow unchanged.
 */
app.get('/oauth/authorize', async (c) => {
  const query = c.req.query();
  const client = await store.getClient(query.client_id ?? '');
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  if (!client.redirectUris.includes(query.redirect_uri ?? '')) return c.json({ error: 'invalid_redirect_uri' }, 400);
  if (query.response_type !== 'code') return c.json({ error: 'unsupported_response_type' }, 400);
  if (query.code_challenge_method !== 'S256' || !query.code_challenge) {
    return c.json({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }, 400);
  }

  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize ${escapeHtml(client.clientName)}</title></head>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
  <h1>Authorize ${escapeHtml(client.clientName)}</h1>
  <p><strong>${escapeHtml(client.clientName)}</strong> is asking to use Popcorn browser sessions on your behalf.</p>
  <ul>
    <li>It can start isolated cloud browser sessions and spend your Popcorn credit.</li>
    <li>Each session costs ${McpConfig.sessionPriceUsdCents} cents. It cannot add credit without you approving a payment.</li>
    <li>It never receives your card details, and never touches your local browser profile.</li>
  </ul>
  <form method="post" action="/oauth/decision">
    ${hidden('client_id', query.client_id)}${hidden('redirect_uri', query.redirect_uri)}
    ${hidden('state', query.state ?? '')}${hidden('code_challenge', query.code_challenge)}
    ${hidden('scope', query.scope ?? 'popcorn.sessions popcorn.credit')}
    <label>Popcorn account email<br><input name="account" type="email" required style="width:100%;padding:.5rem"></label>
    <p><button type="submit" style="padding:.6rem 1.2rem">Approve</button></p>
  </form>
</body></html>`);
});

app.post('/oauth/decision', async (c) => {
  const form = await c.req.parseBody();
  const clientId = String(form.client_id ?? '');
  const redirectUri = String(form.redirect_uri ?? '');
  const account = String(form.account ?? '').trim().toLowerCase();
  const client = await store.getClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri) || !account) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const code = newAuthorizationCode();
  await store.putCode({
    code,
    clientId,
    subject: subjectFor(account),
    redirectUri,
    codeChallenge: String(form.code_challenge ?? ''),
    codeChallengeMethod: 'S256',
    scope: String(form.scope ?? 'popcorn.sessions popcorn.credit'),
    expiresAt: Date.now() + 60_000,
    consumed: false,
  });

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (form.state) target.searchParams.set('state', String(form.state));
  return c.redirect(target.toString(), 302);
});

app.post('/oauth/token', async (c) => {
  const form = await c.req.parseBody();
  if (String(form.grant_type ?? '') !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400);
  }
  const stored = await store.consumeCode(String(form.code ?? ''));
  if (!stored || stored.expiresAt < Date.now()) return c.json({ error: 'invalid_grant' }, 400);
  if (stored.clientId !== String(form.client_id ?? '')) return c.json({ error: 'invalid_grant' }, 400);
  if (stored.redirectUri !== String(form.redirect_uri ?? '')) return c.json({ error: 'invalid_grant' }, 400);
  if (!verifyChallenge(String(form.code_verifier ?? ''), stored.codeChallenge)) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
  }

  return c.json({
    access_token: issueAccessToken(stored.subject, stored.scope),
    token_type: 'Bearer',
    expires_in: McpConfig.accessTokenTtlSeconds,
    scope: stored.scope,
  });
});

/* ------------------------------------------------------------------- MCP */

app.all('/mcp', async (c) => {
  if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405);
  const header = c.req.header('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) {
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${McpConfig.publicUrl}/.well-known/oauth-protected-resource"`,
    );
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const ctx = { store, subject: claims.sub };
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((entry) => handleRpc(ctx, entry as JsonRpcRequest)))).filter(Boolean);
    return responses.length ? c.json(responses) : c.body(null, 202);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  }
  const response = await handleRpc(ctx, body as JsonRpcRequest);
  return response ? c.json(response) : c.body(null, 202);
});

/* ---------------------------------------------------------------- Stripe */

app.post('/stripe/webhook', async (c) => {
  const payload = await c.req.text();
  const signature = c.req.header('stripe-signature') ?? '';
  if (!verifyWebhookSignature(payload, signature, McpConfig.stripeWebhookSecret)) {
    return c.json({ error: 'invalid_signature' }, 400);
  }
  const event = JSON.parse(payload);
  if (event.type !== 'checkout.session.completed') return c.json({ received: true });

  const session = event.data?.object ?? {};
  if (session.payment_status !== 'paid') return c.json({ received: true });
  const topUpId = session.metadata?.popcorn_top_up_id ?? session.client_reference_id;
  const topUp = topUpId ? await store.getTopUp(String(topUpId)) : null;
  if (!topUp) return c.json({ received: true, ignored: 'unknown top-up' });

  await credit(store, topUp.subject, topUp.amountUsdCents, `stripe:${session.id}`);
  await store.updateTopUpStatus(topUp.id, 'credited');
  return c.json({ received: true });
});

function hidden(name: string, value: unknown): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(String(value ?? ''))}">`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
  );
}

export default { port: McpConfig.port, fetch: app.fetch };
export { app, store };
