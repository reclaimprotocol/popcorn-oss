import { afterEach, describe, expect, test } from 'bun:test';
import { ExternalBillingProvider, NoBillingProvider } from './billing';

const context = { subject: 'device:abc', operationId: 'session:abc:key-1', operation: 'create_session' as const };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    seen.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return handler(url, init);
  }) as typeof fetch;
  return seen;
}

describe('NoBillingProvider', () => {
  test('allows everything and reports an unmetered balance', async () => {
    const provider = new NoBillingProvider();
    expect(await provider.getBalance('device:abc')).toBeNull();
    const reservation = await provider.reserve(context);
    expect(reservation.ok).toBe(true);
  });
});

describe('ExternalBillingProvider', () => {
  test('sends the shared operation id so the provider can dedupe retries', async () => {
    const seen = stubFetch(() => Response.json({ allowed: true, reservation_id: 'res-1' }));
    const provider = new ExternalBillingProvider('http://billing.internal/', 'tok');
    const reservation = await provider.reserve(context);
    expect(reservation).toEqual({ ok: true, reservationId: 'res-1' });
    expect(seen[0].url).toBe('http://billing.internal/v1/reservations');
    expect(seen[0].body).toEqual({
      subject: 'device:abc',
      operation_id: 'session:abc:key-1',
      operation: 'create_session',
    });
  });

  test('passes an approval hint through without interpreting it', async () => {
    stubFetch(() => Response.json({ allowed: false, reason: 'insufficient_credit', approval_url: 'https://billing.example/checkout' }));
    const provider = new ExternalBillingProvider('http://billing.internal', 'tok');
    const reservation = await provider.reserve(context);
    expect(reservation).toEqual({
      ok: false,
      reason: 'insufficient_credit',
      nextAction: { type: 'external_approval', url: 'https://billing.example/checkout' },
    });
  });

  test('a billing outage is reported as unavailable, never as allowed', async () => {
    stubFetch(() => {
      throw new Error('connection refused');
    });
    const provider = new ExternalBillingProvider('http://billing.internal', 'tok');
    expect(await provider.reserve(context)).toEqual({ ok: false, reason: 'billing_unavailable' });
  });

  test('a 500 from billing is unavailable, not insufficient credit', async () => {
    stubFetch(() => new Response('boom', { status: 503 }));
    const provider = new ExternalBillingProvider('http://billing.internal', 'tok');
    expect(await provider.reserve(context)).toEqual({ ok: false, reason: 'billing_unavailable' });
  });

  test('commit and release address the reservation by id', async () => {
    const seen = stubFetch(() => new Response(null, { status: 204 }));
    const provider = new ExternalBillingProvider('http://billing.internal', 'tok');
    await provider.commit('res-1');
    await provider.release('res-1');
    expect(seen.map((call) => call.url)).toEqual([
      'http://billing.internal/v1/reservations/res-1/commit',
      'http://billing.internal/v1/reservations/res-1/release',
    ]);
  });

  test('balance is read as a plain credit count', async () => {
    stubFetch(() => Response.json({ balance: 42 }));
    const provider = new ExternalBillingProvider('http://billing.internal', 'tok');
    expect(await provider.getBalance('device:abc')).toBe(42);
  });
});
