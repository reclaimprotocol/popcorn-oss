import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from './db';
import {
  x402CleanupOutbox,
  x402Events,
  x402OperationClaims,
  x402Payments,
  x402SettlementOutbox,
  x402Sessions,
} from './schema';
import { withLeaseClaims, type X402LeaseGuard } from './x402-coordination';
export { X402ClaimBusyError } from './x402-coordination';

export type X402PaymentRow = typeof x402Payments.$inferSelect;
export type X402SessionRow = typeof x402Sessions.$inferSelect;
export type X402SettlementOutboxRow = typeof x402SettlementOutbox.$inferSelect;
export type X402CleanupOutboxRow = typeof x402CleanupOutbox.$inferSelect;

export interface ReservePaymentInput {
  idempotencyKey: string;
  requestHash: string;
  operation: 'create' | 'extend';
  sessionId?: string;
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
  blocks: number;
  facilitatorUrl: string;
}

const CLAIM_LEASE_MILLISECONDS = 2 * 60 * 1000;

export const X402Store = {
  async withLocks<T>(idempotencyKey: string, sessionId: string | undefined, callback: (guard: X402LeaseGuard) => Promise<T>): Promise<T> {
    const keys = [
      `idempotency:${idempotencyKey}`,
      ...(sessionId ? [`session:${sessionId}`] : []),
    ];
    return await withLeaseClaims(keys, {
      acquire: async (claimKey, owner) => {
        const leaseExpiresAt = new Date(Date.now() + CLAIM_LEASE_MILLISECONDS);
        // This insert uses a raw SQL fragment, so Drizzle has no timestamp
        // column encoder for interpolated values. postgres.js cannot bind a
        // Date object through that untyped path; send its ISO representation
        // and let PostgreSQL coerce it for the timestamp target column.
        const rows = await db.execute(sql`
          insert into x402_operation_claims
            (claim_key, owner, operation, lease_expires_at, created_at, updated_at)
          values (${claimKey}, ${owner}, 'request', ${leaseExpiresAt.toISOString()}, now(), now())
          on conflict (claim_key) do update set
            owner = excluded.owner,
            operation = excluded.operation,
            lease_expires_at = excluded.lease_expires_at,
            updated_at = now()
          where x402_operation_claims.lease_expires_at <= now()
          returning claim_key
        `);
        return rows.length > 0;
      },
      renew: async (claimKey, owner) => {
        const rows = await db.update(x402OperationClaims).set({
          leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MILLISECONDS),
          updatedAt: new Date(),
        }).where(and(eq(x402OperationClaims.claimKey, claimKey), eq(x402OperationClaims.owner, owner)))
          .returning({ claimKey: x402OperationClaims.claimKey });
        return rows.length > 0;
      },
      release: async (claimKey, owner) => {
        await db.delete(x402OperationClaims)
          .where(and(eq(x402OperationClaims.claimKey, claimKey), eq(x402OperationClaims.owner, owner)));
      },
    }, callback);
  },

  async reservePayment(input: ReservePaymentInput): Promise<X402PaymentRow> {
    await db.insert(x402Payments).values(input).onConflictDoNothing({
      target: x402Payments.idempotencyKey,
    });
    const [payment] = await db.select().from(x402Payments)
      .where(eq(x402Payments.idempotencyKey, input.idempotencyKey)).limit(1);
    if (!payment) throw new Error('Failed to reserve x402 idempotency key');
    return payment;
  },

  async getPayment(id: string): Promise<X402PaymentRow | undefined> {
    const [payment] = await db.select().from(x402Payments).where(eq(x402Payments.id, id)).limit(1);
    return payment;
  },

  async getPaymentByIdempotencyKey(idempotencyKey: string): Promise<X402PaymentRow | undefined> {
    const [payment] = await db.select().from(x402Payments)
      .where(eq(x402Payments.idempotencyKey, idempotencyKey)).limit(1);
    return payment;
  },

  async findPaymentByPayloadHash(payloadHash: string): Promise<X402PaymentRow | undefined> {
    const [payment] = await db.select().from(x402Payments)
      .where(eq(x402Payments.paymentPayloadHash, payloadHash)).limit(1);
    return payment;
  },

  async updatePayment(id: string, values: Partial<typeof x402Payments.$inferInsert>): Promise<void> {
    await db.update(x402Payments).set({ ...values, updatedAt: new Date() }).where(eq(x402Payments.id, id));
  },

  async addEvent(input: {
    paymentId?: string;
    sessionId?: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await db.insert(x402Events).values(input);
  },

  async createSessionAccess(input: {
    sessionId: string;
    managementTokenHash: string;
    paidBlocks: number;
    expiresAt: Date;
  }): Promise<void> {
    await db.insert(x402Sessions).values(input);
  },

  async getSessionAccess(sessionId: string): Promise<X402SessionRow | undefined> {
    const [access] = await db.select().from(x402Sessions)
      .where(eq(x402Sessions.sessionId, sessionId)).limit(1);
    return access;
  },

  async updateSessionAccess(sessionId: string, input: { paidBlocks: number; expiresAt: Date }): Promise<void> {
    await db.update(x402Sessions).set({ ...input, updatedAt: new Date() })
      .where(eq(x402Sessions.sessionId, sessionId));
  },

  async enqueueCleanup(input: {
    paymentId: string;
    sessionId: string;
    region: string;
    reason: string;
    lastError?: string;
  }): Promise<void> {
    await db.insert(x402CleanupOutbox).values(input);
  },

  async listPendingCleanups(limit = 10): Promise<X402CleanupOutboxRow[]> {
    return await db.select().from(x402CleanupOutbox)
      .where(eq(x402CleanupOutbox.status, 'pending'))
      .limit(Math.max(1, Math.min(50, limit)));
  },

  async completeCleanup(id: string): Promise<void> {
    await db.update(x402CleanupOutbox).set({ status: 'completed', updatedAt: new Date(), lastError: null })
      .where(eq(x402CleanupOutbox.id, id));
  },

  async markCleanupAttempt(id: string, error: string): Promise<void> {
    await db.update(x402CleanupOutbox).set({
      attempts: sql`${x402CleanupOutbox.attempts} + 1`,
      lastError: error,
      updatedAt: new Date(),
    }).where(eq(x402CleanupOutbox.id, id));
  },

  async prepareSettlement(input: {
    paymentId: string;
    sessionId: string;
    operation: 'create' | 'extend';
    response: Record<string, unknown>;
    settlementRequestEncrypted: string;
    settlementStartBlock: bigint;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.insert(x402SettlementOutbox).values(input).onConflictDoUpdate({
        target: x402SettlementOutbox.paymentId,
        set: {
          status: 'pending',
          response: input.response,
          settlementRequestEncrypted: input.settlementRequestEncrypted,
          settlementStartBlock: input.settlementStartBlock,
          updatedAt: new Date(),
          lastError: null,
        },
      });
      const paymentRows = await tx.update(x402Payments).set({
        status: 'settlement_pending',
        response: input.response,
        updatedAt: new Date(),
      }).where(eq(x402Payments.id, input.paymentId))
        .returning({ id: x402Payments.id });
      if (paymentRows.length !== 1) throw new Error('Payment ledger row is missing');
    });
  },

  async prepareExtensionIntent(input: {
    paymentId: string;
    sessionId: string;
    response: Record<string, unknown>;
    settlementRequestEncrypted: string;
    settlementStartBlock: bigint;
    recovery: Record<string, unknown>;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.insert(x402SettlementOutbox).values({
        ...input,
        operation: 'extend',
        status: 'operation_pending',
      }).onConflictDoUpdate({
        target: x402SettlementOutbox.paymentId,
        set: {
          status: 'operation_pending',
          response: input.response,
          settlementRequestEncrypted: input.settlementRequestEncrypted,
          settlementStartBlock: input.settlementStartBlock,
          recovery: input.recovery,
          updatedAt: new Date(),
          lastError: null,
        },
      });
      const rows = await tx.update(x402Payments).set({
        status: 'operation_pending',
        response: input.response,
        updatedAt: new Date(),
      }).where(eq(x402Payments.id, input.paymentId))
        .returning({ id: x402Payments.id });
      if (rows.length !== 1) throw new Error('Payment ledger row is missing');
    });
  },

  async prepareCreateIntent(input: {
    paymentId: string;
    sessionId: string;
    response: Record<string, unknown>;
    settlementRequestEncrypted: string;
    settlementStartBlock: bigint;
    recovery: Record<string, unknown>;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.insert(x402SettlementOutbox).values({
        ...input,
        operation: 'create',
        status: 'operation_pending',
      });
      const rows = await tx.update(x402Payments).set({
        status: 'operation_pending',
        response: input.response,
        updatedAt: new Date(),
      }).where(eq(x402Payments.id, input.paymentId))
        .returning({ id: x402Payments.id });
      if (rows.length !== 1) throw new Error('Payment ledger row is missing');
    });
  },

  async armOperationSettlement(paymentId: string, response: Record<string, unknown>): Promise<void> {
    await db.transaction(async (tx) => {
      const outboxRows = await tx.update(x402SettlementOutbox).set({
        status: 'pending',
        response,
        updatedAt: new Date(),
        lastError: null,
      }).where(and(
        eq(x402SettlementOutbox.paymentId, paymentId),
        eq(x402SettlementOutbox.status, 'operation_pending'),
      )).returning({ paymentId: x402SettlementOutbox.paymentId });
      const paymentRows = await tx.update(x402Payments).set({
        status: 'settlement_pending',
        response,
        updatedAt: new Date(),
      }).where(eq(x402Payments.id, paymentId))
        .returning({ id: x402Payments.id });
      if (outboxRows.length !== 1 || paymentRows.length !== 1) {
        throw new Error('Operation intent could not be armed for settlement');
      }
    });
  },

  async requireExtensionRecovery(paymentId: string, error: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.update(x402SettlementOutbox).set({
        status: 'operation_pending',
        attempts: sql`${x402SettlementOutbox.attempts} + 1`,
        lastError: error,
        updatedAt: new Date(),
      }).where(eq(x402SettlementOutbox.paymentId, paymentId));
      await tx.update(x402Payments).set({
        status: 'extension_recovery_required',
        failureReason: error,
        updatedAt: new Date(),
      }).where(eq(x402Payments.id, paymentId));
    });
  },

  async listPendingOperationIntents(limit = 10): Promise<X402SettlementOutboxRow[]> {
    return await db.select().from(x402SettlementOutbox)
      .where(and(
        eq(x402SettlementOutbox.status, 'operation_pending'),
        lt(x402SettlementOutbox.updatedAt, new Date(Date.now() - 5 * 1000)),
      ))
      .limit(Math.max(1, Math.min(50, limit)));
  },

  async getSettlementOutbox(paymentId: string): Promise<X402SettlementOutboxRow | undefined> {
    const [row] = await db.select().from(x402SettlementOutbox)
      .where(eq(x402SettlementOutbox.paymentId, paymentId)).limit(1);
    return row;
  },

  async finalizeSettlement(input: {
    paymentId: string;
    payerWallet?: string;
    transactionHash: string;
    settlementResponse: Record<string, unknown>;
    response: Record<string, unknown>;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      const paymentRows = await tx.update(x402Payments).set({
        status: 'settled',
        payerWallet: input.payerWallet,
        transactionHash: input.transactionHash,
        settlementResponse: input.settlementResponse,
        response: input.response,
        settledAt: new Date(),
        failureReason: null,
        updatedAt: new Date(),
      }).where(eq(x402Payments.id, input.paymentId))
        .returning({ id: x402Payments.id });
      const outboxRows = await tx.update(x402SettlementOutbox).set({
        status: 'completed',
        settlementResponse: input.settlementResponse,
        response: input.response,
        completedAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
      }).where(eq(x402SettlementOutbox.paymentId, input.paymentId))
        .returning({ paymentId: x402SettlementOutbox.paymentId });
      if (paymentRows.length !== 1 || outboxRows.length !== 1) {
        throw new Error('Settlement ledger or outbox row is missing');
      }
    });
  },

  async failSettlementOutbox(paymentId: string, error: string): Promise<void> {
    await db.update(x402SettlementOutbox).set({
      status: 'failed',
      attempts: sql`${x402SettlementOutbox.attempts} + 1`,
      lastError: error,
      updatedAt: new Date(),
    }).where(eq(x402SettlementOutbox.paymentId, paymentId));
  },

  async listPendingSettlements(limit = 10): Promise<X402SettlementOutboxRow[]> {
    return await db.select().from(x402SettlementOutbox)
      .where(and(
        eq(x402SettlementOutbox.status, 'pending'),
        lt(x402SettlementOutbox.updatedAt, new Date(Date.now() - 5 * 1000)),
      ))
      .limit(Math.max(1, Math.min(50, limit)));
  },

  async markSettlementReconciliationAttempt(paymentId: string, error?: string): Promise<void> {
    await db.update(x402SettlementOutbox).set({
      attempts: sql`${x402SettlementOutbox.attempts} + 1`,
      lastError: error || null,
      updatedAt: new Date(),
    }).where(eq(x402SettlementOutbox.paymentId, paymentId));
  },

  async cleanupStaleState(): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from x402_operation_claims where lease_expires_at <= now()`);
      await tx.execute(sql`delete from x402_rate_limits where updated_at < now() - interval '2 hours'`);
      await tx.execute(sql`
        with stale as (
          select id from x402_payments
          where status in ('challenge_issued', 'verification_failed', 'allocation_failed', 'extension_failed', 'settlement_failed')
            and updated_at < now() - interval '24 hours'
          order by updated_at
          limit 500
        )
        delete from x402_settlement_outbox using stale
        where x402_settlement_outbox.payment_id = stale.id
          and x402_settlement_outbox.status = 'failed'
      `);
      await tx.execute(sql`
        with stale as (
          select id from x402_payments
          where status in ('challenge_issued', 'verification_failed', 'allocation_failed', 'extension_failed', 'settlement_failed')
            and updated_at < now() - interval '24 hours'
          order by updated_at
          limit 500
        )
        delete from x402_events using stale where x402_events.payment_id = stale.id
      `);
      await tx.execute(sql`
        with stale as (
          select id from x402_payments
          where status in ('challenge_issued', 'verification_failed', 'allocation_failed', 'extension_failed', 'settlement_failed')
            and updated_at < now() - interval '24 hours'
          order by updated_at
          limit 500
        )
        delete from x402_payments using stale where x402_payments.id = stale.id
      `);
    });
  },

  async consumeRateLimit(key: string, limit: number): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
    const rows = await db.execute(sql`
      insert into x402_rate_limits (key, window_started_at, count, updated_at)
      values (${key}, now(), 1, now())
      on conflict (key) do update set
        count = case
          when x402_rate_limits.window_started_at <= now() - interval '1 minute' then 1
          else x402_rate_limits.count + 1
        end,
        window_started_at = case
          when x402_rate_limits.window_started_at <= now() - interval '1 minute' then now()
          else x402_rate_limits.window_started_at
        end,
        updated_at = now()
      returning count, window_started_at
    `);
    const row = rows[0] as { count?: number; window_started_at?: Date | string } | undefined;
    const count = Number(row?.count || 1);
    const startedAt = new Date(row?.window_started_at || Date.now()).getTime();
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: Math.max(1, Math.ceil((startedAt + 60_000 - Date.now()) / 1000)),
    };
  },

  async getSettledPaymentForSession(sessionId: string): Promise<X402PaymentRow | undefined> {
    const [payment] = await db.select().from(x402Payments)
      .where(and(eq(x402Payments.sessionId, sessionId), eq(x402Payments.status, 'settled')))
      .limit(1);
    return payment;
  },

  async getUnresolvedPaymentForSession(sessionId: string): Promise<X402PaymentRow | undefined> {
    const [payment] = await db.select().from(x402Payments)
      .where(and(
        eq(x402Payments.sessionId, sessionId),
        sql`${x402Payments.status} in ('operation_pending', 'settlement_pending', 'reconciliation_required', 'extension_recovery_required')`,
      ))
      .limit(1);
    return payment;
  },

  async getUnresolvedExtensionForSession(sessionId: string): Promise<X402SettlementOutboxRow | undefined> {
    const [row] = await db.select().from(x402SettlementOutbox)
      .where(and(
        eq(x402SettlementOutbox.sessionId, sessionId),
        eq(x402SettlementOutbox.operation, 'extend'),
        sql`${x402SettlementOutbox.status} in ('operation_pending', 'pending')`,
      ))
      .limit(1);
    return row;
  },
};
