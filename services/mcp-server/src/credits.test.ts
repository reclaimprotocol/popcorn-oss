import { describe, expect, test } from 'bun:test';
import { InsufficientCredit, credit, debit, refund, validateTopUpAmount } from './credits';
import { InMemoryStore } from './store';

describe('popcorn credit', () => {
  test('credits once per payment reference', async () => {
    const store = new InMemoryStore();
    expect((await credit(store, 's', 500, 'stripe:1')).credited).toBe(true);
    expect((await credit(store, 's', 500, 'stripe:1')).credited).toBe(false);
    expect(await store.balanceUsdCents('s')).toBe(500);
  });

  test('debits are idempotent on ref', async () => {
    const store = new InMemoryStore();
    await credit(store, 's', 100, 'stripe:1');
    await debit(store, 's', 5, 'session:1', 'session');
    await debit(store, 's', 5, 'session:1', 'session');
    expect(await store.balanceUsdCents('s')).toBe(95);
  });

  test('refuses to overdraw', async () => {
    const store = new InMemoryStore();
    await credit(store, 's', 4, 'stripe:1');
    await expect(debit(store, 's', 5, 'session:1', 'session')).rejects.toBeInstanceOf(InsufficientCredit);
    expect(await store.balanceUsdCents('s')).toBe(4);
  });

  test('balances are isolated per subject', async () => {
    const store = new InMemoryStore();
    await credit(store, 'a', 500, 'stripe:a');
    expect(await store.balanceUsdCents('b')).toBe(0);
  });

  test('refunds restore a failed debit', async () => {
    const store = new InMemoryStore();
    await credit(store, 's', 100, 'stripe:1');
    await debit(store, 's', 5, 'session:1', 'session');
    await refund(store, 's', 5, 'session:1');
    expect(await store.balanceUsdCents('s')).toBe(100);
  });

  test('concurrent debits cannot overdraw', async () => {
    const store = new InMemoryStore();
    await credit(store, 's', 5, 'stripe:1');
    const results = await Promise.allSettled([
      debit(store, 's', 5, 'session:a', 'session'),
      debit(store, 's', 5, 'session:b', 'session'),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await store.balanceUsdCents('s')).toBe(0);
  });

  test('validates top-up bounds', () => {
    expect(validateTopUpAmount(1)).toBeString();
    expect(validateTopUpAmount(5)).toBeNull();
    expect(validateTopUpAmount(10_000_000)).toBeString();
    expect(validateTopUpAmount(500)).toBeNull();
  });
});

describe('fixed session SKU', () => {
  test('duration is server-side, not caller-controlled', async () => {
    const { TOOL_DEFINITIONS } = await import('./tools');
    const create = TOOL_DEFINITIONS.find((tool) => tool.name === 'create_browser_session')!;
    const extend = TOOL_DEFINITIONS.find((tool) => tool.name === 'extend_browser_session')!;
    expect(Object.keys(create.inputSchema.properties)).not.toContain('ttl_seconds');
    expect(Object.keys(extend.inputSchema.properties)).not.toContain('ttl_seconds');
  });
});
