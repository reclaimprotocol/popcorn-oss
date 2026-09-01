import { describe, expect, test } from 'bun:test';
import { NoBillingProvider, type BillingProvider, type Reservation, type UsageContext } from './billing';
import { PROTOCOL_VERSION, handleRpc } from './mcp';
import { InMemoryStore } from './store';

function ctx(billing: BillingProvider = new NoBillingProvider()) {
  return { store: new InMemoryStore(), subject: 'device:test', billing };
}

function toolResult(response: unknown): any {
  return (response as any).result;
}

function toolPayload(response: unknown): any {
  const result = toolResult(response);
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find((item: any) => item.type === 'text')?.text;
  return JSON.parse(text);
}

/** Records what the tool layer asked billing to do, in order. */
class RecordingBilling implements BillingProvider {
  readonly name = 'recording';
  readonly calls: string[] = [];
  constructor(private readonly outcome: Reservation = { ok: true, reservationId: 'r-1' }) {}

  async getBalance() {
    return 7;
  }

  async reserve(context: UsageContext): Promise<Reservation> {
    this.calls.push(`reserve:${context.operation}:${context.operationId}`);
    return this.outcome;
  }

  async commit(reservationId: string) {
    this.calls.push(`commit:${reservationId}`);
  }

  async release(reservationId: string) {
    this.calls.push(`release:${reservationId}`);
  }
}

describe('mcp surface', () => {
  test('initialize advertises the protocol version and tools capability', async () => {
    const response = await handleRpc(ctx(), { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((response as any).result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect((response as any).result.capabilities.tools).toBeDefined();
  });

  test('tools/list exposes the browser surface and no payment tool', async () => {
    const response = await handleRpc(ctx(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (response as any).result.tools.map((tool: any) => tool.name);
    expect(names).toEqual([
      'get_balance',
      'create_browser_session',
      'get_browser_session',
      'get_browser_connection',
      'get_live_view',
      'verify_runtime',
      'end_browser_session',
      'list_browser_sessions',
    ]);
    expect(JSON.stringify((response as any).result.tools).toLowerCase()).not.toContain('stripe');
    for (const tool of (response as any).result.tools) {
      expect(tool.title).toBeString();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: true,
      });
    }
  });

  test('notifications do not produce a response', async () => {
    expect(await handleRpc(ctx(), { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  test('unknown methods return method-not-found', async () => {
    const response = await handleRpc(ctx(), { jsonrpc: '2.0', id: 3, method: 'nope' });
    expect((response as any).error.code).toBe(-32601);
  });
});

describe('billing boundary', () => {
  test('get_balance reports credits from the provider, not money', async () => {
    const response = await handleRpc(ctx(new RecordingBilling()), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_balance', arguments: {} },
    });
    const payload = toolPayload(response);
    expect(payload).toEqual({
      credits: 7,
      metered: true,
      session_block_seconds: 600,
      credits_per_operation: 1,
    });
    expect(JSON.stringify(payload)).not.toContain('usd');
  });

  test('an unmetered deployment reports a null balance', async () => {
    const response = await handleRpc(ctx(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_balance', arguments: {} },
    });
    expect(toolPayload(response)).toMatchObject({ credits: null, metered: false });
  });

  test('a refused reservation surfaces the provider next_action opaquely', async () => {
    const billing = new RecordingBilling({
      ok: false,
      reason: 'insufficient_credit',
      nextAction: { type: 'external_approval', url: 'https://billing.example/checkout' },
    });
    const response = await handleRpc(ctx(billing), {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'log in to acme', idempotency_key: 'approval' } },
    });
    const payload = toolPayload(response);
    expect(toolResult(response).isError).toBe(true);
    expect(toolResult(response).structuredContent).toBeUndefined();
    expect(payload.error).toBe('insufficient_credit');
    expect(payload.next_action).toEqual({ type: 'external_approval', url: 'https://billing.example/checkout' });
    // Reserved once and refused: nothing was committed or released.
    expect(billing.calls).toHaveLength(1);
    expect(billing.calls[0]).toStartWith('reserve:create_session:');
  });

  test('a billing outage does not hand out free browser time', async () => {
    const billing = new RecordingBilling({ ok: false, reason: 'billing_unavailable' });
    const response = await handleRpc(ctx(billing), {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'outage' } },
    });
    expect(toolPayload(response).error).toBe('billing_unavailable');
  });

  test('invalid placement is rejected before reserving credit', async () => {
    const billing = new RecordingBilling();
    const response = await handleRpc(ctx(billing), {
      jsonrpc: '2.0',
      id: 70,
      method: 'tools/call',
      params: {
        name: 'create_browser_session',
        arguments: { purpose: 'x', idempotency_key: 'bad-placement', regions: [], proxy_country: 'USA' },
      },
    });
    expect(toolPayload(response).error).toBe('invalid_request');
    expect(billing.calls).toEqual([]);
  });

  test('a refused reservation releases the claim so the same key can be retried', async () => {
    const billing = new RecordingBilling({ ok: false, reason: 'insufficient_credit' });
    const context = ctx(billing);
    await handleRpc(context, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'k' } },
    });
    expect(await context.store.getOperation(`session:${context.subject}:k`)).toBeNull();
  });

  test('reservation and operation share one id, so both sides can dedupe a retry', async () => {
    const billing = new RecordingBilling({ ok: false, reason: 'insufficient_credit' });
    const context = ctx(billing);
    await handleRpc(context, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'shared' } },
    });
    expect(billing.calls[0]).toBe(`reserve:create_session:session:${context.subject}:shared`);
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

  test('a retried create returns the first terminal outcome, not a second browser', async () => {
    const context = ctx();
    const ref = `session:${context.subject}:key-1`;
    const payload = {
      session_id: 'sess-first',
      live_view_url: 'https://view.example/sess-first',
      cdp_url: 'wss://cdp.example/sess-first?token=opaque',
      expires_at: '2030-01-01T00:00:00.000Z',
      region: 'test',
      isolation: 'isolated',
      human_handoff: 'Send this URL to the human.',
      usage_settled: true,
    };
    await context.store.claimOperation(ref, context.subject);
    await context.store.settleOperation(ref, 'succeeded', payload);
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'key-1' } },
    });
    const result = toolResult(response);
    expect(result.structuredContent).toEqual(payload);
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(payload) });
    expect(result.content[1]).toMatchObject({
      type: 'resource_link',
      uri: payload.live_view_url,
      mimeType: 'text/html',
    });
    expect(result._meta['org.reclaimprotocol.popcorn/browser-session']).toEqual(payload);
  });

  test('a retry after a released reservation replays the failure, not a free session', async () => {
    const billing = new RecordingBilling();
    const context = ctx(billing);
    const ref = `session:${context.subject}:key-2`;
    await context.store.claimOperation(ref, context.subject);
    await context.store.settleOperation(ref, 'failed', { error: 'session_unavailable' });
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'key-2' } },
    });
    expect((response as any).result.isError).toBe(true);
    expect(billing.calls).toEqual([]);
  });

  test('a call arriving while the claim is pending does not start a second browser', async () => {
    const context = ctx(new RecordingBilling());
    await context.store.claimOperation(`session:${context.subject}:key-3`, context.subject);
    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'key-3' } },
    });
    expect(toolPayload(response).error).toBe('operation_in_progress');
  });

  test('a stale pending claim can be recovered by exactly one caller', async () => {
    const context = ctx();
    const ref = `session:${context.subject}:stale`;
    await context.store.claimOperation(ref, context.subject, 0);
    const [first, second] = await Promise.all([
      context.store.claimOperation(ref, context.subject),
      context.store.claimOperation(ref, context.subject),
    ]);
    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
  });

  test('create requires an explicit idempotency key', async () => {
    const response = await handleRpc(ctx(), {
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x' } },
    });
    expect(toolPayload(response).error).toBe('invalid_request');
  });
});
