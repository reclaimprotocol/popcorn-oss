import crypto from 'crypto';
import { McpConfig } from './config';
import type { McpStore } from './store';

/**
 * Popcorn credit: closed-loop, non-transferable, non-withdrawable prepaid
 * balance denominated in USD cents. Usable only for Popcorn browser sessions.
 */

export class InsufficientCredit extends Error {
  constructor(
    readonly balanceUsdCents: number,
    readonly requiredUsdCents: number,
  ) {
    super('insufficient Popcorn credit');
  }
}

export async function getBalance(store: McpStore, subject: string): Promise<number> {
  return store.balanceUsdCents(subject);
}

/** Credits are added exactly once per payment reference (webhook-safe). */
export async function credit(
  store: McpStore,
  subject: string,
  amountUsdCents: number,
  ref: string,
  reason = 'top_up',
): Promise<{ credited: boolean; balanceUsdCents: number }> {
  if (amountUsdCents <= 0) throw new Error('credit amount must be positive');
  if (await store.hasLedgerRef(ref)) {
    return { credited: false, balanceUsdCents: await store.balanceUsdCents(subject) };
  }
  await store.appendLedger({
    id: crypto.randomUUID(),
    subject,
    deltaUsdCents: amountUsdCents,
    reason,
    ref,
    createdAt: Date.now(),
  });
  return { credited: true, balanceUsdCents: await store.balanceUsdCents(subject) };
}

/** Debits are idempotent on `ref` so a retried tool call never double-charges. */
export async function debit(
  store: McpStore,
  subject: string,
  amountUsdCents: number,
  ref: string,
  reason: string,
): Promise<number> {
  if (amountUsdCents < 0) throw new Error('debit amount must not be negative');
  if (await store.hasLedgerRef(ref)) {
    return store.balanceUsdCents(subject);
  }
  const balance = await store.balanceUsdCents(subject);
  if (balance < amountUsdCents) {
    throw new InsufficientCredit(balance, amountUsdCents);
  }
  await store.appendLedger({
    id: crypto.randomUUID(),
    subject,
    deltaUsdCents: -amountUsdCents,
    reason,
    ref,
    createdAt: Date.now(),
  });
  return store.balanceUsdCents(subject);
}

/** Refund a debit that could not be fulfilled (e.g. allocation failure). */
export async function refund(
  store: McpStore,
  subject: string,
  amountUsdCents: number,
  ref: string,
): Promise<void> {
  await credit(store, subject, amountUsdCents, `refund:${ref}`, 'refund');
}

export function validateTopUpAmount(amountUsdCents: number): string | null {
  if (!Number.isInteger(amountUsdCents)) return 'amount_usd_cents must be an integer number of cents';
  if (amountUsdCents < McpConfig.minTopUpUsdCents) {
    return `minimum top-up is ${McpConfig.minTopUpUsdCents} cents`;
  }
  if (amountUsdCents > McpConfig.maxTopUpUsdCents) {
    return `maximum top-up is ${McpConfig.maxTopUpUsdCents} cents`;
  }
  return null;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
