import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, boolean, jsonb, index, integer, bigint, uniqueIndex, check } from 'drizzle-orm/pg-core';

export const clients = pgTable('clients', {
  id: text('id').primaryKey(), // e.g., "client_abc123"
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull(), // bcrypt hash
  createdAt: timestamp('created_at').defaultNow().notNull(),
  active: boolean('active').default(true).notNull(),
  // NULL preserves the legacy behavior: access to every non-reserved cluster.
  // An explicit array is a durable allowlist and an empty array denies routing.
  allowedClusters: jsonb('allowed_clusters').$type<string[] | null>(),
});

// Main sessions table - optimized for analytics queries
export const sessions = pgTable('sessions', {
  sessionId: text('session_id').primaryKey(),
  clientId: text('client_id').references(() => clients.id).notNull(),
  clientName: text('client_name').notNull(), // Denormalized for easy identification
  clusterName: text('cluster_name').notNull(),
  region: text('region'),

  // Time tracking
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),
  endedAt: timestamp('ended_at', { mode: 'date' }),

  // Lifecycle
  status: text('status').notNull().default('active'), // 'active' | 'deleted' | 'expired'

  // Additional metadata
  metadata: jsonb('metadata'),
}, (table) => ({
  // Indexes for common query patterns
  clientIdx: index('sessions_client_idx').on(table.clientId),
  clusterIdx: index('sessions_cluster_idx').on(table.clusterName),
  regionIdx: index('sessions_region_idx').on(table.region),
  createdAtIdx: index('sessions_created_at_idx').on(table.createdAt),
  endedAtIdx: index('sessions_ended_at_idx').on(table.endedAt),
  statusIdx: index('sessions_status_idx').on(table.status),

  // Composite indexes for common query combinations
  clientTimeIdx: index('sessions_client_time_idx').on(table.clientId, table.createdAt),
  clusterTimeIdx: index('sessions_cluster_time_idx').on(table.clusterName, table.createdAt),
}));

// Event audit log - for detailed tracking (optional, can be disabled for performance)
export const sessionEvents = pgTable('session_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').references(() => sessions.sessionId).notNull(),
  eventType: text('event_type').notNull(), // 'created' | 'deleted' | 'expired'
  timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
  metadata: jsonb('metadata'),
}, (table) => ({
  sessionIdx: index('session_events_session_idx').on(table.sessionId),
  timestampIdx: index('session_events_timestamp_idx').on(table.timestamp),
}));

// Durable source of truth for public x402 payments. Revenue queries must only
// include rows whose status is `settled`.
export const x402Payments = pgTable('x402_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  paymentPayloadHash: text('payment_payload_hash'),
  paymentSignatureHash: text('payment_signature_hash'),
  operation: text('operation').notNull(), // 'create' | 'extend'
  sessionId: text('session_id').references(() => sessions.sessionId),
  payerWallet: text('payer_wallet'),
  network: text('network').notNull(),
  asset: text('asset'),
  amountAtomic: text('amount_atomic').notNull(),
  payTo: text('pay_to').notNull(),
  blocks: integer('blocks').notNull(),
  status: text('status').notNull().default('challenge_issued'),
  facilitatorUrl: text('facilitator_url').notNull(),
  transactionHash: text('transaction_hash'),
  failureReason: text('failure_reason'),
  response: jsonb('response'),
  settlementResponse: jsonb('settlement_response'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { mode: 'date' }),
}, (table) => ({
  idempotencyKeyIdx: uniqueIndex('x402_payments_idempotency_key_idx').on(table.idempotencyKey),
  paymentPayloadHashIdx: uniqueIndex('x402_payments_payload_hash_idx').on(table.paymentPayloadHash),
  transactionHashIdx: uniqueIndex('x402_payments_transaction_hash_idx').on(table.transactionHash),
  sessionIdx: index('x402_payments_session_idx').on(table.sessionId),
  statusCreatedIdx: index('x402_payments_status_created_idx').on(table.status, table.createdAt),
  payerIdx: index('x402_payments_payer_idx').on(table.payerWallet),
  operationCheck: check('x402_payments_operation_check', sql`${table.operation} in ('create', 'extend')`),
  blocksCheck: check('x402_payments_blocks_check', sql`${table.blocks} > 0`),
  amountAtomicCheck: check('x402_payments_amount_atomic_check', sql`${table.amountAtomic} ~ '^[1-9][0-9]*$'`),
}));

// Stores public x402 access state separately from normal client sessions. The
// URL capability is derived on demand; only its hash is persisted.
export const x402Sessions = pgTable('x402_sessions', {
  sessionId: text('session_id').primaryKey().references(() => sessions.sessionId),
  capabilityHash: text('capability_hash').notNull(),
  paidBlocks: integer('paid_blocks').notNull().default(1),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  capabilityHashIdx: uniqueIndex('x402_sessions_capability_hash_idx').on(table.capabilityHash),
  paidBlocksCheck: check('x402_sessions_paid_blocks_check', sql`${table.paidBlocks} > 0`),
}));

export const x402Events = pgTable('x402_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').references(() => x402Payments.id),
  sessionId: text('session_id'),
  eventType: text('event_type').notNull(),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),
  metadata: jsonb('metadata'),
}, (table) => ({
  paymentIdx: index('x402_events_payment_idx').on(table.paymentId),
  sessionIdx: index('x402_events_session_idx').on(table.sessionId),
  typeTimestampIdx: index('x402_events_type_timestamp_idx').on(table.eventType, table.timestamp),
}));

// Durable cleanup outbox. A worker/operator can retry rows until completed;
// the configured paid TTL remains the final containment boundary.
export const x402CleanupOutbox = pgTable('x402_cleanup_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').references(() => x402Payments.id).notNull(),
  sessionId: text('session_id').notNull(),
  region: text('region').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  statusIdx: index('x402_cleanup_outbox_status_idx').on(table.status, table.createdAt),
  sessionIdx: index('x402_cleanup_outbox_session_idx').on(table.sessionId),
  attemptsCheck: check('x402_cleanup_outbox_attempts_check', sql`${table.attempts} >= 0`),
}));

// Short-lived cross-replica leases. Network calls never run inside a database
// transaction or while a connection-scoped advisory lock is held.
export const x402OperationClaims = pgTable('x402_operation_claims', {
  claimKey: text('claim_key').primaryKey(),
  owner: text('owner').notNull(),
  operation: text('operation').notNull(),
  leaseExpiresAt: timestamp('lease_expires_at', { mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  leaseIdx: index('x402_operation_claims_lease_idx').on(table.leaseExpiresAt),
}));

// Written before settlement. Payment and outbox completion are finalized in
// one short transaction after settlement returns.
export const x402SettlementOutbox = pgTable('x402_settlement_outbox', {
  paymentId: uuid('payment_id').primaryKey().references(() => x402Payments.id),
  sessionId: text('session_id').notNull(),
  operation: text('operation').notNull(),
  status: text('status').notNull().default('pending'),
  response: jsonb('response').notNull(),
  settlementRequestEncrypted: text('settlement_request_encrypted').notNull(),
  settlementStartBlock: bigint('settlement_start_block', { mode: 'bigint' }).notNull(),
  recovery: jsonb('recovery'),
  settlementResponse: jsonb('settlement_response'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table) => ({
  statusIdx: index('x402_settlement_outbox_status_idx').on(table.status, table.createdAt),
  sessionIdx: index('x402_settlement_outbox_session_idx').on(table.sessionId),
}));

export const x402RateLimits = pgTable('x402_rate_limits', {
  key: text('key').primaryKey(),
  windowStartedAt: timestamp('window_started_at', { mode: 'date' }).notNull(),
  count: integer('count').notNull().default(0),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  updatedIdx: index('x402_rate_limits_updated_idx').on(table.updatedAt),
}));

// Example queries this schema enables:

// 1. Sessions per cluster in time range:
// SELECT cluster_name, COUNT(*) as session_count
// FROM sessions
// WHERE created_at >= '2026-03-01' AND created_at < '2026-04-01'
// GROUP BY cluster_name;

// 2. Top clients by session count:
// SELECT client_id, COUNT(*) as session_count
// FROM sessions
// WHERE created_at >= '2026-03-01'
// GROUP BY client_id
// ORDER BY session_count DESC
// LIMIT 10;

// 3. Average session duration by client:
// SELECT
//   client_id,
//   COUNT(*) as total_sessions,
//   AVG(EXTRACT(EPOCH FROM (ended_at - created_at))) as avg_duration_seconds,
//   SUM(EXTRACT(EPOCH FROM (ended_at - created_at))) as total_duration_seconds
// FROM sessions
// WHERE ended_at IS NOT NULL
// GROUP BY client_id;

// 4. Active sessions (currently running):
// SELECT session_id, client_id, cluster_name, created_at
// FROM sessions
// WHERE status = 'active' AND ended_at IS NULL;

// 5. Sessions by status and cluster:
// SELECT cluster_name, status, COUNT(*) as count
// FROM sessions
// WHERE created_at >= NOW() - INTERVAL '24 hours'
// GROUP BY cluster_name, status;
