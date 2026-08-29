import { BillingCommitError, type BillingProvider } from './billing';
import type { McpStore } from './store';

/**
 * Billing-commit reconciliation.
 *
 * A billed operation performs the browser effect BEFORE committing its
 * reservation, so a commit lost to a timeout, an outage or a crash would leave
 * the provider holding a reservation it will eventually expire — handing out a
 * session that was actually delivered. Every such commit is recorded durably
 * and retried here until the provider confirms it.
 *
 * Commit is idempotent on the provider side, and a provider that already
 * expired the reservation is expected to re-debit on a late commit, so
 * retrying is always safe and never double-charges.
 */

/** Exponential backoff, capped, so a long outage does not hammer billing. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 15 * 60_000);
}

export async function reconcileCommits(
  store: McpStore,
  billing: BillingProvider,
  options: { now?: number; limit?: number } = {},
): Promise<{ settled: number; deferred: number; abandoned: number }> {
  const now = options.now ?? Date.now();
  const due = await store.dueCommits(now, options.limit ?? 50);
  let settled = 0;
  let deferred = 0;
  let abandoned = 0;

  for (const pending of due) {
    try {
      await billing.commit(pending.reservationId);
      await store.deletePendingCommit(pending.reservationId);
      settled += 1;
    } catch (error) {
      const message = error instanceof BillingCommitError ? error.message : String(error);
      if (error instanceof BillingCommitError && error.terminal) {
        // The provider will never accept this commit. Stop retrying, but say
        // so loudly: usage was delivered that nobody paid for.
        console.error(
          `UNSETTLED USAGE: commit permanently refused for reservation ${pending.reservationId} ` +
            `(${pending.operation}, ${pending.operationRef}): ${message}`,
        );
        await store.deletePendingCommit(pending.reservationId);
        abandoned += 1;
        continue;
      }
      await store.recordCommitAttempt(pending.reservationId, message, now + backoffMs(pending.attempts + 1));
      deferred += 1;
    }
  }

  return { settled, deferred, abandoned };
}

/** Run reconciliation on an interval; returns a stop function. */
export function startCommitReconciler(
  store: McpStore,
  billing: BillingProvider,
  intervalMs = 30_000,
): () => void {
  const timer = setInterval(() => {
    reconcileCommits(store, billing).catch((error) => console.error('commit reconciliation failed', error));
  }, intervalMs);
  // Never hold the process open just for the sweep.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
