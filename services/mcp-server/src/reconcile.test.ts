import { describe, expect, test } from 'bun:test';
import { BillingCommitError, NoBillingProvider, type BillingProvider, type Reservation, type UsageContext } from './billing';
import { handleRpc } from './mcp';
import { backoffMs, reconcileCommits } from './reconcile';
import { InMemoryStore } from './store';

/** A provider whose commit fails until told otherwise. */
class FlakyBilling implements BillingProvider {
  readonly name = 'flaky';
  commits = 0;
  constructor(private failure: BillingCommitError | null) {}

  async getBalance() {
    return 10;
  }

  async reserve(_context: UsageContext): Promise<Reservation> {
    return { ok: true, reservationId: 'res-1' };
  }

  async commit() {
    this.commits += 1;
    if (this.failure) throw this.failure;
  }

  async release() {}

  recover() {
    this.failure = null;
  }
}

const pending = {
  reservationId: 'res-1',
  subject: 'device:abc',
  operationRef: 'session:abc:key-1',
  operation: 'create_session',
  attempts: 0,
  lastError: null,
  createdAt: Date.now(),
  nextAttemptAt: Date.now(),
};

describe('commit reconciliation', () => {
  test('a deferred commit is retried until billing confirms it', async () => {
    const store = new InMemoryStore();
    const billing = new FlakyBilling(new BillingCommitError('commit rejected with 503', false));
    await store.putPendingCommit({ ...pending });

    const first = await reconcileCommits(store, billing);
    expect(first).toMatchObject({ settled: 0, deferred: 1 });
    // Still owed, and not lost.
    expect(await store.dueCommits(Date.now() + 60_000, 10)).toHaveLength(1);

    billing.recover();
    const second = await reconcileCommits(store, billing, { now: Date.now() + 60_000 });
    expect(second).toMatchObject({ settled: 1 });
    expect(await store.dueCommits(Date.now() + 60_000, 10)).toHaveLength(0);
  });

  test('a permanently refused commit is abandoned rather than retried forever', async () => {
    const store = new InMemoryStore();
    const billing = new FlakyBilling(new BillingCommitError('commit rejected with 409', true));
    await store.putPendingCommit({ ...pending });

    expect(await reconcileCommits(store, billing)).toMatchObject({ abandoned: 1 });
    expect(await store.dueCommits(Date.now() + 60_000, 10)).toHaveLength(0);
    expect(billing.commits).toBe(1);
  });

  test('a commit that is not yet due is left alone', async () => {
    const store = new InMemoryStore();
    const billing = new FlakyBilling(null);
    await store.putPendingCommit({ ...pending, nextAttemptAt: Date.now() + 60_000 });

    expect(await reconcileCommits(store, billing)).toMatchObject({ settled: 0, deferred: 0 });
    expect(billing.commits).toBe(0);
  });

  test('backoff grows and is capped', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(99)).toBe(15 * 60_000);
  });
});

describe('a failed commit is never treated as success', () => {
  test('the obligation is recorded durably and the result says it is unsettled', async () => {
    const store = new InMemoryStore();
    const billing = new FlakyBilling(new BillingCommitError('commit unreachable: timeout', false));
    const context = { store, subject: 'device:abc', billing };

    // Pre-settle the operation record so the tool replays a known outcome
    // rather than calling the real control plane.
    const ref = `session:${context.subject}:key-x`;
    await store.claimOperation(ref, context.subject);
    await store.settleOperation(ref, 'succeeded', { session_id: 'sess-1', usage_settled: false });

    const response = await handleRpc(context, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_browser_session', arguments: { purpose: 'x', idempotency_key: 'key-x' } },
    });
    expect((response as any).result.structuredContent.usage_settled).toBe(false);
  });

  test('an unmetered deployment has nothing to reconcile', async () => {
    const store = new InMemoryStore();
    expect(await reconcileCommits(store, new NoBillingProvider())).toMatchObject({ settled: 0 });
  });
});
