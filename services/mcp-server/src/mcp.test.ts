import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, handleRpc } from './mcp';
import { credit } from './credits';
import { InMemoryStore } from './store';
import { verifyWebhookSignature } from './stripe';
import crypto from 'crypto';

function ctx() {
  const store = new InMemoryStore();
  return { store, subject: 'popcorn:test' };
}

describe('mcp surface', () => {
  test('initialize advertises the protocol version and tools capability', async () => {
    const response = await handleRpc(ctx(), { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((response as any).result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect((response as any).result.capabilities.tools).toBeDefined();
  });

  test('tools/list exposes exactly the paid browser surface', async () => {
    const response = await handleRpc(ctx(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (response as any).result.tools.map((tool: any) => tool.name);
    expect(names).toEqual([
      'get_balance',
      'top_up',
      'create_browser_session',
      'get_browser_session',
      'get_browser_connection',
      'get_live_view',
      'verify_runtime',
      'extend_browser_session',
      'end_browser_session',
      'list_browser_sessions',
    ]);
  });

  test('notifications do not produce a response', async () => {
    expect(await handleRpc(ctx(), { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  test('unknown methods return method-not-found', async () => {
    const response = await handleRpc(ctx(), { jsonrpc: '2.0', id: 3, method: 'nope' });
    expect((response as any).error.code).toBe(-32601);
  });

  test('get_balance reports closed-loop credit for the calling subject', async () => {
    const context = ctx();
    await credit(context.store, context.subject, 500, 'stripe:1');
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_balance', arguments: {} },
    });
    expect((response as any).result.structuredContent.balance_usd_cents).toBe(500);
  });

  test('create_browser_session refuses without credit and points at top_up', async () => {
    const response = await handleRpc(ctx(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'log in to acme' } },
    });
    const payload = (response as any).result.structuredContent;
    expect((response as any).result.isError).toBe(true);
    expect(payload.error).toBe('insufficient_credit');
    expect(payload.next).toContain('top_up');
  });

  test('sessions belonging to another subject are not visible', async () => {
    const context = ctx();
    await context.store.putSession({
      sessionId: 'sess-1',
      subject: 'popcorn:someone-else',
      purpose: 'other',
      createdAt: Date.now(),
      expiresAt: null,
      endedAt: null,
    });
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_browser_session', arguments: { session_id: 'sess-1' } },
    });
    expect((response as any).result.structuredContent.error).toBe('not_found');
  });
});

describe('stripe webhook signatures', () => {
  test('accepts a correctly signed payload and rejects tampering', () => {
    const secret = 'whsec_test';
    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const timestamp = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    expect(verifyWebhookSignature(payload, `t=${timestamp},v1=${v1}`, secret)).toBe(true);
    expect(verifyWebhookSignature(`${payload} `, `t=${timestamp},v1=${v1}`, secret)).toBe(false);
  });

  test('rejects stale timestamps', () => {
    const secret = 'whsec_test';
    const payload = '{}';
    const timestamp = Math.floor(Date.now() / 1000) - 10_000;
    const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    expect(verifyWebhookSignature(payload, `t=${timestamp},v1=${v1}`, secret)).toBe(false);
  });
});

describe('operation idempotency', () => {
  test('only one concurrent call with the same key may act', async () => {
    const context = ctx();
    const ref = `session:${context.subject}:race`;
    const [first, second] = await Promise.all([
      context.store.claimOperation(ref, context.subject),
      context.store.claimOperation(ref, context.subject),
    ]);
    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
  });

  test('a call arriving while the claim is pending does not start a second browser', async () => {
    const context = ctx();
    await credit(context.store, context.subject, 100, 'stripe:1');
    await context.store.claimOperation(`session:${context.subject}:key-3`, context.subject);
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'key-3' } },
    });
    expect((response as any).result.structuredContent.error).toBe('operation_in_progress');
    expect(await context.store.balanceUsdCents(context.subject)).toBe(100);
  });

  test('a retried create returns the first terminal outcome, not a second browser', async () => {
    const context = ctx();
    await context.store.claimOperation(`session:${context.subject}:key-1`, context.subject);
    await context.store.settleOperation(`session:${context.subject}:key-1`, 'succeeded', { session_id: 'sess-first' });
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'key-1' } },
    });
    expect((response as any).result.structuredContent).toEqual({ session_id: 'sess-first' });
  });

  test('a retry after a refunded failure replays the failure instead of granting a free session', async () => {
    const context = ctx();
    await credit(context.store, context.subject, 100, 'stripe:1');
    await context.store.claimOperation(`session:${context.subject}:key-2`, context.subject);
    await context.store.settleOperation(`session:${context.subject}:key-2`, 'failed', {
      error: 'session_unavailable',
      refunded_usd_cents: 5,
    });
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'key-2' } },
    });
    expect((response as any).result.isError).toBe(true);
    expect(await context.store.balanceUsdCents(context.subject)).toBe(100);
  });
});

describe('top-up idempotency', () => {
  test('a retried top_up returns the same Checkout link instead of a second charge', async () => {
    const context = ctx();
    const ref = `topup:${context.subject}:key-1`;
    await context.store.claimOperation(ref, context.subject);
    await context.store.putTopUp({
      id: 'tu-1',
      subject: context.subject,
      amountUsdCents: 500,
      status: 'pending',
      checkoutUrl: 'https://checkout.stripe.com/first',
      providerRef: 'cs_first',
      createdAt: Date.now(),
    });
    await context.store.settleOperation(ref, 'succeeded', {
      top_up_id: 'tu-1',
      amount_usd_cents: 500,
      approval_url: 'https://checkout.stripe.com/first',
    });

    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'top_up', arguments: { amount_usd_cents: 500, idempotency_key: 'key-1' } },
    });
    const content = (response as any).result.structuredContent;
    expect(content.approval_url).toBe('https://checkout.stripe.com/first');
    expect(content.replayed).toBe(true);
  });

  test('an under-minimum top_up is refused with the minimum stated', async () => {
    const context = ctx();
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'top_up', arguments: { amount_usd_cents: 5 } },
    });
    const content = (response as any).result.structuredContent;
    expect(content.error).toBe('invalid_amount');
    expect(content.minimum_usd_cents).toBe(500);
  });
});
