import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';

export const clients = pgTable('clients', {
  id: text('id').primaryKey(), // e.g., "client_abc123"
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull(), // bcrypt hash
  createdAt: timestamp('created_at').defaultNow().notNull(),
  active: boolean('active').default(true).notNull(),
});

export const sessionEvents = pgTable('session_events', {
  id: uuid('id').notNull().defaultRandom(),
  sessionId: text('session_id').notNull(),
  clientId: text('client_id').references(() => clients.id).notNull(),
  clusterName: text('cluster_name').notNull(),
  eventType: text('event_type').notNull(), // 'created' | 'deleted' | 'expired'
  timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
  endTimestamp: timestamp('end_timestamp', { mode: 'date' }), // Set for 'deleted'/'expired' events
  metadata: jsonb('metadata'),
}, (table) => ({
  // Composite primary key with timestamp for TimescaleDB partitioning
  pk: primaryKey({ columns: [table.id, table.timestamp] }),
  clientIdx: index('session_events_client_idx').on(table.clientId, table.timestamp),
  clusterIdx: index('session_events_cluster_idx').on(table.clusterName, table.timestamp),
  timestampIdx: index('session_events_timestamp_idx').on(table.timestamp),
  sessionIdx: index('session_events_session_idx').on(table.sessionId),
}));
