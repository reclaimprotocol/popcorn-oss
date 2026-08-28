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
import { PostgresStore } from './src/postgres-store';
import { issueNonce, verifyDeviceProof } from './src/device';
import { verifyWebhookSignature } from './src/stripe';

/**
 * Durable storage when DATABASE_URL is set; in-memory only for local dev,
 * tests, and demos.
 */
const store: McpStore = McpConfig.databaseUrl
  ? PostgresStore.fromUrl(McpConfig.databaseUrl)
  : new InMemoryStore();
const durable = store instanceof PostgresStore;
// Tests drive the same store the app uses.
(globalThis as Record<string, unknown>).__mcpStore = store;
if (durable) await (store as PostgresStore).migrate();

/**
 * Refuse to run against live Stripe keys on ephemeral storage. Credits,
 * pending top-ups, OAuth clients, codes and session ownership are held in
 * memory and vanish on restart — that is fine for a demo, never for money.
 */
if (!durable && McpConfig.stripeSecretKey.startsWith('sk_live_') && process.env.MCP_ALLOW_EPHEMERAL_STORE !== 'true') {
  throw new Error(
    'Refusing to start: a live Stripe key is configured but storage is in-memory. Set DATABASE_URL (see services/mcp-server/README.md).',
  );
}
const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', storage: durable ? 'postgres' : 'memory' }));

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
 * Sign-in + consent — anonymous, no account.
 *
 * The page generates a non-extractable ECDSA P-256 keypair in the browser,
 * stores it in IndexedDB, and signs a server nonce. The public key's
 * thumbprint becomes the OAuth subject that owns the credit balance. Nothing
 * about the human is collected, and the MCP client never sees the key.
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

/** Popcorn brand tokens, matching popcorn.reclaimprotocol.org. */
const BRAND_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;800&family=DM+Mono:wght@400;500&display=swap');
  :root {
    --ink: #17170f;
    --muted: #66665b;
    --cream: #f6f2e4;
    --paper: #fffdf4;
    --yellow: #f7d93d;
    --yellow-soft: #ffe879;
    --green: #b9d86b;
    --line: #17170f2e;
    --font-sans: 'Manrope', Arial, sans-serif;
    --font-mono: 'DM Mono', ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--cream); color: var(--ink);
    font-family: var(--font-sans); -webkit-font-smoothing: antialiased;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px 16px;
  }
  .shell { width: min(560px, 100%); }
  .card { background: var(--paper); border: 2px solid var(--ink); padding: 32px; box-shadow: 8px 8px 0 var(--ink); }
  .kicker {
    display: flex; align-items: center; gap: 10px; margin: 0 0 20px;
    font-family: var(--font-mono); font-size: 11px; letter-spacing: .09em; text-transform: uppercase;
  }
  .kicker > span { background: #b49b00; width: 22px; height: 2px; }
  h1 { font-size: 30px; line-height: 1.15; letter-spacing: -.03em; margin: 0 0 10px; font-weight: 800; }
  h1 .pop { background: var(--yellow); box-shadow: 0 0 0 6px var(--yellow); }
  .lede { color: var(--muted); font-size: 16px; line-height: 1.65; letter-spacing: -.015em; margin: 18px 0 0; }
  .notes { list-style: none; padding: 0; margin: 26px 0 0; display: grid; gap: 12px; }
  .notes li { display: flex; gap: 12px; align-items: flex-start; font-size: 14px; line-height: 1.55; }
  .notes li b { font-weight: 600; }
  .tick { flex: none; width: 22px; height: 22px; border: 2px solid var(--ink); background: var(--green);
          display: grid; place-items: center; font-size: 11px; font-family: var(--font-mono); }
  .tick.warn { background: var(--yellow-soft); }
  .tick.dev { background: var(--paper); }
  .button {
    display: inline-flex; align-items: center; justify-content: center; gap: 12px; width: 100%;
    min-height: 52px; margin-top: 28px; padding: 0 20px; cursor: pointer;
    border: 2px solid var(--ink); background: var(--ink); color: var(--paper);
    font-family: var(--font-mono); font-size: 12px; letter-spacing: .03em; text-transform: uppercase;
    transition: transform .16s, box-shadow .16s;
  }
  .button:hover { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--ink); }
  .button:disabled { opacity: .6; cursor: progress; transform: none; box-shadow: none; }
  .status { margin: 14px 0 0; min-height: 20px; font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
  .fine { margin: 22px 0 0; padding-top: 18px; border-top: 1px solid var(--line);
          font-size: 12px; line-height: 1.6; color: var(--muted); }
  .fine code { font-family: var(--font-mono); background: var(--yellow-soft); padding: 1px 5px; }
  .alert { border: 2px solid var(--ink); background: var(--yellow-soft); padding: 12px 14px; margin: 0 0 20px;
           font-size: 14px; }
`;

function page(title: string, inner: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BRAND_CSS}</style></head>
<body><main class="shell"><div class="card">${inner}</div></main>${script}</body></html>`;
}

function noticeHtml(message: string): string {
  return `<p class="alert" role="alert">${escapeHtml(message)}</p>`;
}

/** Browser-side: keypair in IndexedDB, sign the nonce, POST the proof. */
const DEVICE_SCRIPT = `<script>
const DB = 'popcorn-device', STORE = 'keys', KEY = 'device';
function idb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const request = fn(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function deviceKey() {
  const db = await idb();
  const existing = await tx(db, 'readonly', (s) => s.get(KEY));
  if (existing) return existing;
  // Non-extractable: the private key can never leave this browser.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await tx(db, 'readwrite', (s) => s.put(pair, KEY));
  return pair;
}
async function approve(form) {
  const status = document.getElementById('status');
  status.textContent = 'Verifying this browser…';
  const pair = await deviceKey();
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const nonce = form.dataset.nonce;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(nonce),
  );
  form.public_key.value = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  form.signature.value = btoa(String.fromCharCode(...new Uint8Array(signature)));
  form.submit();
}
document.getElementById('approve').addEventListener('submit', (event) => {
  event.preventDefault();
  approve(event.target).catch((error) => {
    const button = event.target.querySelector('button');
    if (button) button.disabled = false;
    document.getElementById('status').textContent = 'This browser could not create a device key: ' + error.message;
  });
});
</script>`;

function hiddenParams(params: AuthorizeParams): string {
  return (Object.keys(params) as Array<keyof AuthorizeParams>).map((key) => hidden(key, params[key])).join('');
}

app.get('/oauth/authorize', async (c) => {
  const query = c.req.query();
  const params = readAuthorizeParams(query);
  const client = await validateAuthorizeParams(params);
  if (!client) {
    return c.json(
      { error: 'invalid_request', error_description: `unknown client/redirect_uri, or missing resource (must be ${RESOURCE_URI()})` },
      400,
    );
  }
  if (query.response_type !== 'code') return c.json({ error: 'unsupported_response_type' }, 400);
  if (query.code_challenge_method !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }, 400);
  }

  const nonce = await issueNonce(store);
  return c.html(
    page(
      `Authorize ${client.clientName}`,
      `<p class="kicker"><span></span>Popcorn · isolated cloud browsers</p>
  <h1>You're all set! <span class="pop">No login</span> needed to use Popcorn!</h1>
  <p class="lede">Pay as you go — <strong>${escapeHtml(client.clientName)}</strong> gets ${McpConfig.sessionPriceUsdCents}¢ browser sessions on your credit, and nothing else.</p>
  <ul class="notes">
    <li><span class="tick">✓</span><span><b>No account, no password, no email.</b> This page mints a key that never leaves this browser — that key is your balance.</span></li>
    <li><span class="tick warn">!</span><span><b>Top up only what your agent needs.</b> Card fees mean credit is bought in one go (from ${McpConfig.minTopUpUsdCents / 100} minimum) and spent ${McpConfig.sessionPriceUsdCents}¢ at a time. Unused credit may be lost — it's closed-loop, non-transferable and non-refundable.</span></li>
    <li><span class="tick dev">⌘</span><span><b>Building a product?</b> Use the <a href="https://docs.x402.org/guides/mcp-server-with-x402">x402 endpoint</a> instead of this browser flow.</span></li>
  </ul>
  <form id="approve" method="post" action="/oauth/decision" data-nonce="${escapeHtml(nonce.value)}">
    ${hiddenParams(params)}${hidden('nonce', nonce.value)}
    <input type="hidden" name="public_key"><input type="hidden" name="signature">
    <button class="button" type="submit">Approve ${escapeHtml(client.clientName)}</button>
    <p class="status" id="status"></p>
  </form>
  <p class="fine">Each session buys one fixed block of <code>${McpConfig.sessionTtlSeconds / 60} min</code> for <code>${McpConfig.sessionPriceUsdCents}¢</code>. Clearing this site's data or switching browsers starts a fresh, empty balance.</p>`,
      DEVICE_SCRIPT,
    ),
  );
});

app.post('/oauth/decision', async (c) => {
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const params = readAuthorizeParams(form);
  const client = await validateAuthorizeParams(params);
  if (!client) return c.json({ error: 'invalid_request' }, 400);

  let publicKeyJwk: unknown = null;
  try {
    publicKeyJwk = JSON.parse(String(form.public_key ?? 'null'));
  } catch {
    publicKeyJwk = null;
  }
  const proof = await verifyDeviceProof(store, {
    publicKeyJwk,
    nonce: String(form.nonce ?? ''),
    signatureB64: String(form.signature ?? ''),
  });
  if (!proof.ok) {
    return c.html(page('Authorization failed', noticeHtml(proof.message)), 400);
  }

  const code = newAuthorizationCode();
  await store.putCode({
    code,
    clientId: params.client_id,
    subject: proof.subject,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: 'S256',
    scope: params.scope,
    resource: params.resource,
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
  // The token must be issued for the SAME resource the code was bound to.
  const requestedResource = form.resource ? String(form.resource) : null;
  if (!resourceMatches(requestedResource) || requestedResource !== stored.resource) {
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
 * Revocation. Prove possession of the device key and every token issued to
 * that identity before now stops working. Credit is untouched.
 */
app.get('/oauth/revoke', async (c) => {
  const nonce = await issueNonce(store);
  return c.html(
    page(
      'Revoke agent access',
      `<p class="kicker"><span></span>Popcorn · access control</p>
  <h1>Cut off <span class="pop">every agent</span> on this browser</h1>
  <p class="lede">This signs out every MCP client authorized on this browser's key. Your Popcorn credit stays exactly where it is.</p>
  <form id="approve" method="post" action="/oauth/revoke/confirm" data-nonce="${escapeHtml(nonce.value)}">
    ${hidden('nonce', nonce.value)}
    <input type="hidden" name="public_key"><input type="hidden" name="signature">
    <button class="button" type="submit">Revoke all access</button>
    <p class="status" id="status"></p>
  </form>`,
      DEVICE_SCRIPT,
    ),
  );
});

app.post('/oauth/revoke/confirm', async (c) => {
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  let publicKeyJwk: unknown = null;
  try {
    publicKeyJwk = JSON.parse(String(form.public_key ?? 'null'));
  } catch {
    publicKeyJwk = null;
  }
  const proof = await verifyDeviceProof(store, {
    publicKeyJwk,
    nonce: String(form.nonce ?? ''),
    signatureB64: String(form.signature ?? ''),
  });
  if (!proof.ok) return c.html(page('Revoke agent access', noticeHtml(proof.message)), 400);
  await store.revokeSubjectBefore(proof.subject, Date.now());
  return c.html(
    page(
      'Access revoked',
      `<p class="kicker"><span></span>Popcorn · access control</p>
  <h1>Access <span class="pop">revoked</span></h1>
  <p class="lede">Every MCP client authorized on this identity has been signed out. Your Popcorn credit is unchanged.</p>`,
    ),
  );
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

  // Bind the paid Checkout Session to the stored purchase before crediting:
  // the session id must be the one we created for this top-up, and the amount
  // and currency must be exactly what was requested. Anything else is a
  // mismatch we refuse to turn into credit.
  if (topUp.providerRef && String(session.id) !== topUp.providerRef) {
    console.error(`stripe webhook session ${session.id} does not match top-up ${topUp.id} (${topUp.providerRef})`);
    return c.json({ error: 'session_mismatch' }, 400);
  }
  if (!topUp.providerRef) {
    // Checkout was created but the id had not landed yet; retry shortly.
    return c.json({ error: 'top_up_not_ready', retry: true }, 503);
  }
  const paidAmount = Number(session.amount_total);
  const currency = String(session.currency ?? '').toLowerCase();
  if (paidAmount !== topUp.amountUsdCents || currency !== 'usd') {
    console.error(
      `stripe webhook amount mismatch on top-up ${topUp.id}: paid ${paidAmount} ${currency}, expected ${topUp.amountUsdCents} usd`,
    );
    return c.json({ error: 'amount_mismatch' }, 400);
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
