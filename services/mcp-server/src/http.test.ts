import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { app } from '../index';

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('streamable http transport', () => {
  test('unauthenticated calls get a 401 with resource metadata', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  test('rejects a disallowed browser Origin', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  test('rejects an unsupported MCP-Protocol-Version', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' });
    expect(response.status).toBe(400);
  });

  test('rejects JSON-RPC batches', async () => {
    const response = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error.message).toContain('one JSON-RPC message per POST');
  });

  test('publishes protected-resource metadata for discovery', async () => {
    const response = await app.request('/.well-known/oauth-protected-resource');
    const body = (await response.json()) as any;
    expect(body.resource).toEndWith('/mcp');
  });
});

describe('authorization page', () => {
  test('renders the pay-as-you-go copy in Popcorn brand styling', async () => {
    const registered = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }),
    });
    const client = (await registered.json()) as any;
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/cb',
      response_type: 'code',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      resource: 'http://localhost:3000/mcp',
    });
    const html = await (await app.request(`/oauth/authorize?${query}`)).text();
    expect(html).toContain("No login");
    expect(html).toContain('Pay as you go');
    expect(html).toContain('Unused credit may be lost');
    expect(html).toContain('x402 endpoint');
    expect(html).toContain('--yellow: #f7d93d');
    expect(html).toContain('Manrope');
  });
});

describe('stripe webhook binding', () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test';

  async function deliver(session: Record<string, unknown>) {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return app.request('/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` },
      body,
    });
  }

  async function pendingTopUp(id: string, subject: string) {
    await (globalThis as any).__mcpStore.putTopUp({
      id,
      subject,
      amountUsdCents: 500,
      status: 'pending',
      checkoutUrl: 'https://checkout.stripe.com/ours',
      providerRef: 'cs_ours',
      createdAt: Date.now(),
    });
  }

  test('credits once when the session, amount and currency all match', async () => {
    const store = (globalThis as any).__mcpStore;
    await pendingTopUp('tu-ok', 'device:ok');
    const response = await deliver({
      id: 'cs_ours',
      payment_status: 'paid',
      amount_total: 500,
      currency: 'usd',
      metadata: { popcorn_top_up_id: 'tu-ok' },
    });
    expect(response.status).toBe(200);
    expect(await store.balanceUsdCents('device:ok')).toBe(500);

    // Stripe redelivers: the ledger ref makes it a no-op.
    await deliver({
      id: 'cs_ours',
      payment_status: 'paid',
      amount_total: 500,
      currency: 'usd',
      metadata: { popcorn_top_up_id: 'tu-ok' },
    });
    expect(await store.balanceUsdCents('device:ok')).toBe(500);
  });

  test('refuses a session id that is not the one we created', async () => {
    const store = (globalThis as any).__mcpStore;
    await pendingTopUp('tu-mismatch', 'device:mismatch');
    const response = await deliver({
      id: 'cs_attacker',
      payment_status: 'paid',
      amount_total: 500,
      currency: 'usd',
      metadata: { popcorn_top_up_id: 'tu-mismatch' },
    });
    expect(response.status).toBe(400);
    expect(await store.balanceUsdCents('device:mismatch')).toBe(0);
  });

  test('refuses an underpaid or wrong-currency session', async () => {
    const store = (globalThis as any).__mcpStore;
    await pendingTopUp('tu-amount', 'device:amount');
    expect(
      (await deliver({
        id: 'cs_ours',
        payment_status: 'paid',
        amount_total: 50,
        currency: 'usd',
        metadata: { popcorn_top_up_id: 'tu-amount' },
      })).status,
    ).toBe(400);
    expect(
      (await deliver({
        id: 'cs_ours',
        payment_status: 'paid',
        amount_total: 500,
        currency: 'eur',
        metadata: { popcorn_top_up_id: 'tu-amount' },
      })).status,
    ).toBe(400);
    expect(await store.balanceUsdCents('device:amount')).toBe(0);
  });

  test('asks Stripe to retry an unknown top-up instead of swallowing the payment', async () => {
    const response = await deliver({
      id: 'cs_unknown',
      payment_status: 'paid',
      amount_total: 500,
      currency: 'usd',
      metadata: { popcorn_top_up_id: 'tu-nope' },
    });
    expect(response.status).toBe(503);
  });
});
