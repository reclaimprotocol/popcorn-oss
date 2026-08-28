import { Hono } from 'hono';
import { McpConfig } from './src/config';
import { credit } from './src/credits';
import { handleRpc, type JsonRpcRequest } from './src/mcp';
import {
  RESOURCE_URI,
  authorizationServerMetadata,
  issueAccessToken,
  newAuthorizationCode,
  protectedResourceMetadata,
  registerClient,
  resourceMatches,
  verifyAccessToken,
  verifyChallenge,
} from './src/oauth';
import { InMemoryStore, type McpStore } from './src/store';
import { startEmailOtp, verifyEmailOtp } from './src/otp';
import { verifyWebhookSignature } from './src/stripe';

const store: McpStore = new InMemoryStore();

/**
 * Refuse to run against live Stripe keys on ephemeral storage. Credits,
 * pending top-ups, OAuth clients, codes and session ownership are held in
 * memory and vanish on restart — that is fine for a demo, never for money.
 */
if (McpConfig.stripeSecretKey.startsWith('sk_live_') && process.env.MCP_ALLOW_EPHEMERAL_STORE !== 'true') {
  throw new Error(
    'Refusing to start: a live Stripe key is configured but storage is in-memory. Wire a durable McpStore first (see services/mcp-server/README.md).',
  );
}
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
 * Sign-in + consent. Authentication is an emailed one-time code — there is no
 * sign-up step: proving control of an email address IS the account. The email
 * is turned into a stable pseudonymous OAuth subject and never handed to the
 * MCP client.
 */

type AuthorizeParams = {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  scope: string;
  resource: string;
};

function readAuthorizeParams(source: Record<string, unknown>): AuthorizeParams {
  return {
    client_id: String(source.client_id ?? ''),
    redirect_uri: String(source.redirect_uri ?? ''),
    state: String(source.state ?? ''),
    code_challenge: String(source.code_challenge ?? ''),
    scope: String(source.scope ?? 'popcorn.sessions popcorn.credit'),
    resource: String(source.resource ?? ''),
  };
}

async function validateAuthorizeParams(params: AuthorizeParams) {
  const client = await store.getClient(params.client_id);
  if (!client) return null;
  if (!client.redirectUris.includes(params.redirect_uri)) return null;
  if (!params.code_challenge) return null;
  if (!resourceMatches(params.resource)) return null;
  return client;
}

function page(title: string, inner: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui;max-width:30rem;margin:4rem auto;padding:0 1rem;line-height:1.55">${inner}</body></html>`;
}

function hiddenParams(params: AuthorizeParams): string {
  return (Object.keys(params) as Array<keyof AuthorizeParams>).map((key) => hidden(key, params[key])).join('');
}

function emailFormHtml(clientName: string, params: AuthorizeParams, notice = ''): string {
  return page(`Authorize ${clientName}`, `
  <h1 style="font-size:1.4rem">Authorize ${escapeHtml(clientName)}</h1>
  <p><strong>${escapeHtml(clientName)}</strong> is asking to run Popcorn browser sessions on your behalf.</p>
  <ul>
    <li>It can start isolated cloud browsers and spend your Popcorn credit.</li>
    <li>Each session costs ${McpConfig.sessionPriceUsdCents} cents. It cannot add credit without you approving a payment.</li>
    <li>It never receives your card details, your email, or your local browser profile.</li>
  </ul>
  ${notice}
  <form method="post" action="/oauth/email">
    ${hiddenParams(params)}
    <label>Email address<br><input name="email" type="email" required autofocus style="width:100%;padding:.6rem;font-size:1rem"></label>
    <p style="color:#666;font-size:.9rem">We'll email you a 6-digit code. No sign-up, no password.</p>
    <button type="submit" style="padding:.6rem 1.2rem;font-size:1rem">Email me a code</button>
  </form>`);
}

function codeFormHtml(clientName: string, params: AuthorizeParams, challengeId: string, notice = ''): string {
  return page(`Authorize ${clientName}`, `
  <h1 style="font-size:1.4rem">Enter your code</h1>
  <p>We emailed a 6-digit code. It expires in 10 minutes.</p>
  ${notice}
  <form method="post" action="/oauth/decision">
    ${hiddenParams(params)}${hidden('challenge_id', challengeId)}
    <label>Sign-in code<br><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus style="width:100%;padding:.6rem;font-size:1.4rem;letter-spacing:.3rem"></label>
    <p><button type="submit" style="padding:.6rem 1.2rem;font-size:1rem">Approve access</button></p>
  </form>
  <p style="color:#666;font-size:.9rem">Approving lets ${escapeHtml(clientName)} start browser sessions and spend Popcorn credit on this identity until you revoke it.</p>`);
}

function noticeHtml(message: string): string {
  return `<p role="alert" style="background:#fdecea;border:1px solid #f5c6c3;padding:.6rem .8rem;border-radius:.4rem">${escapeHtml(message)}</p>`;
}

app.get('/oauth/authorize', async (c) => {
  const query = c.req.query();
  const params = readAuthorizeParams(query);
  const client = await validateAuthorizeParams(params);
  if (!client) return c.json({ error: 'invalid_request', error_description: 'unknown client or redirect_uri' }, 400);
  if (query.response_type !== 'code') return c.json({ error: 'unsupported_response_type' }, 400);
  if (query.code_challenge_method !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }, 400);
  }
  return c.html(emailFormHtml(client.clientName, params));
});

app.post('/oauth/email', async (c) => {
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const params = readAuthorizeParams(form);
  const client = await validateAuthorizeParams(params);
  if (!client) return c.json({ error: 'invalid_request' }, 400);

  const result = await startEmailOtp(store, String(form.email ?? ''));
  if (!result.ok) {
    const message = result.error === 'send_failed' ? 'We could not send that email. Try again shortly.' : result.message;
    return c.html(emailFormHtml(client.clientName, params, noticeHtml(message)), 400);
  }
  return c.html(codeFormHtml(client.clientName, params, result.challengeId));
});

app.post('/oauth/decision', async (c) => {
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const params = readAuthorizeParams(form);
  const client = await validateAuthorizeParams(params);
  if (!client) return c.json({ error: 'invalid_request' }, 400);

  const challengeId = String(form.challenge_id ?? '');
  const verified = await verifyEmailOtp(store, challengeId, String(form.code ?? ''));
  if (!verified.ok) {
    if (verified.error === 'invalid_code') {
      return c.html(codeFormHtml(client.clientName, params, challengeId, noticeHtml(verified.message)), 400);
    }
    return c.html(emailFormHtml(client.clientName, params, noticeHtml(verified.message)), 400);
  }

  const code = newAuthorizationCode();
  await store.putCode({
    code,
    clientId: params.client_id,
    subject: verified.subject,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: 'S256',
    scope: params.scope,
    expiresAt: Date.now() + 60_000,
    consumed: false,
  });

  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
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
  if (!resourceMatches(form.resource ? String(form.resource) : null)) {
    return c.json({ error: 'invalid_target', error_description: `resource must be ${RESOURCE_URI()}` }, 400);
  }
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

const ALLOWED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26']);

/** DNS-rebinding protection: browsers must come from an allowed origin. */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser MCP clients send no Origin
  const allowed = [McpConfig.publicUrl, ...(process.env.MCP_ALLOWED_ORIGINS ?? '').split(',')]
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return allowed.includes(origin.trim().replace(/\/$/, ''));
}

app.all('/mcp', async (c) => {
  if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405);
  if (!originAllowed(c.req.header('origin'))) return c.json({ error: 'forbidden_origin' }, 403);

  const protocolVersion = c.req.header('mcp-protocol-version');
  if (protocolVersion && !ALLOWED_PROTOCOL_VERSIONS.has(protocolVersion)) {
    return c.json(
      { error: 'unsupported_protocol_version', supported: [...ALLOWED_PROTOCOL_VERSIONS] },
      400,
    );
  }
  const body = await c.req.json().catch(() => null);
  // Streamable HTTP (2025-06-18) is one JSON-RPC message per POST.
  if (Array.isArray(body)) {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batched requests are not supported; send one JSON-RPC message per POST' } },
      400,
    );
  }

  const header = c.req.header('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const claims = token ? verifyAccessToken(token) : null;
  const revokedAt = claims ? await store.revokedAt(claims.sub) : 0;
  if (!claims || claims.iat * 1000 < revokedAt) {
    c.header(
      'WWW-Authenticate',
      `Bearer resource="${RESOURCE_URI()}", resource_metadata="${McpConfig.publicUrl}/.well-known/oauth-protected-resource"`,
    );
    return c.json({ error: 'unauthorized' }, 401);
  }

  const ctx = { store, subject: claims.sub };
  if (!body || typeof body !== 'object') {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  }
  const response = await handleRpc(ctx, body as JsonRpcRequest);
  return response ? c.json(response) : c.body(null, 202);
});

/**
 * Revocation. Every token issued to this identity before now stops working.
 * The consent screen promises this, so it is part of the auth surface, not an
 * admin extra: sign in again with an emailed code and confirm.
 */
app.get('/oauth/revoke', (c) =>
  c.html(
    page(
      'Revoke agent access',
      `<h1 style="font-size:1.4rem">Revoke agent access</h1>
  <p>Enter your email and we'll send a code. Confirming signs out every MCP client currently authorized on your identity. Your Popcorn credit is not affected.</p>
  <form method="post" action="/oauth/revoke/email">
    <label>Email address<br><input name="email" type="email" required autofocus style="width:100%;padding:.6rem;font-size:1rem"></label>
    <p><button type="submit" style="padding:.6rem 1.2rem;font-size:1rem">Email me a code</button></p>
  </form>`,
    ),
  ),
);

app.post('/oauth/revoke/email', async (c) => {
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const result = await startEmailOtp(store, String(form.email ?? ''));
  if (!result.ok) {
    return c.html(page('Revoke agent access', noticeHtml(result.message)), 400);
  }
  return c.html(
    page(
      'Revoke agent access',
      `<h1 style="font-size:1.4rem">Enter your code</h1>
  <form method="post" action="/oauth/revoke/confirm">
    ${hidden('challenge_id', result.challengeId)}
    <label>Sign-in code<br><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus style="width:100%;padding:.6rem;font-size:1.4rem;letter-spacing:.3rem"></label>
    <p><button type="submit" style="padding:.6rem 1.2rem;font-size:1rem">Revoke all access</button></p>
  </form>`,
    ),
  );
});

app.post('/oauth/revoke/confirm', async (c) => {
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const verified = await verifyEmailOtp(store, String(form.challenge_id ?? ''), String(form.code ?? ''));
  if (!verified.ok) return c.html(page('Revoke agent access', noticeHtml(verified.message)), 400);
  await store.revokeSubjectBefore(verified.subject, Date.now());
  return c.html(page('Access revoked', '<h1 style="font-size:1.4rem">Access revoked</h1><p>Every MCP client authorized on this identity has been signed out. Your Popcorn credit is unchanged.</p>'));
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
  if (!topUp) {
    // Do NOT 200 here: a 200 tells Stripe the payment is handled. Fail so it
    // retries while the top-up record catches up.
    console.error(`stripe webhook for unknown top-up ${topUpId ?? '(none)'} on session ${session.id}`);
    return c.json({ error: 'unknown_top_up', retry: true }, 503);
  }

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
