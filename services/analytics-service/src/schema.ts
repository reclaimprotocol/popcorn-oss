import { pgTable, uuid, text, timestamp, boolean, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';

export const clients = pgTable('clients', {
  id: text('id').primaryKey(), // e.g., "client_abc123"
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull(), // bcrypt hash
  createdAt: timestamp('created_at').defaultNow().notNull(),
  active: boolean('active').default(true).notNull(),
});

// Main sessions table - optimized for analytics queries
export const sessions = pgTable('sessions', {
  sessionId: text('session_id').primaryKey(),
  clientId: text('client_id').references(() => clients.id).notNull(),
  clientName: text('client_name').notNull(), // Denormalized for easy identification
  clusterName: text('cluster_name').notNull(),

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
