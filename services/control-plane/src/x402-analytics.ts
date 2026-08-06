import { sql } from 'drizzle-orm';
import { db } from './db';

export async function getX402Analytics(windowHours = 24, blockSeconds = 300) {
  const safeWindowHours = Math.max(1, Math.min(720, Math.floor(windowHours)));
  const [totals, operations, events, live] = await Promise.all([
    db.execute(sql`
      select
        count(*)::int as settled_payments,
        coalesce(sum(amount_atomic::numeric), 0)::text as revenue_atomic,
        count(distinct payer_wallet)::int as unique_payers,
        coalesce(sum(blocks), 0)::int as paid_blocks
      from x402_payments
      where status = 'settled'
        and settled_at >= now() - (${safeWindowHours} * interval '1 hour')
    `),
    db.execute(sql`
      select operation, count(*)::int as payments,
        coalesce(sum(amount_atomic::numeric), 0)::text as revenue_atomic,
        coalesce(sum(blocks), 0)::int as paid_blocks
      from x402_payments
      where status = 'settled'
        and settled_at >= now() - (${safeWindowHours} * interval '1 hour')
      group by operation
      order by operation
    `),
    db.execute(sql`
      select event_type, count(*)::int as count
      from x402_events
      where timestamp >= now() - (${safeWindowHours} * interval '1 hour')
      group by event_type
      order by event_type
    `),
    // Live now, not window-scoped: paid access still valid and the underlying
    // browser session is still active (excludes expired and terminated ones).
    db.execute(sql`
      select count(*)::int as live_sessions
      from x402_sessions x
      join sessions s on s.session_id = x.session_id
      where x.expires_at > now()
        and s.status = 'active'
        and s.ended_at is null
    `),
  ]);
  const row = totals[0] as Record<string, unknown> | undefined;
  const liveRow = live[0] as Record<string, unknown> | undefined;
  return {
    windowHours: safeWindowHours,
    liveSessions: Number(liveRow?.live_sessions || 0),
    // Revenue is deliberately sourced only from status='settled' ledger rows.
    revenueAtomic: String(row?.revenue_atomic || '0'),
    settledPayments: Number(row?.settled_payments || 0),
    uniquePayers: Number(row?.unique_payers || 0),
    paidSeconds: Number(row?.paid_blocks || 0) * blockSeconds,
    operations: operations.map((entry) => ({
      operation: String((entry as any).operation),
      payments: Number((entry as any).payments),
      revenueAtomic: String((entry as any).revenue_atomic),
      paidSeconds: Number((entry as any).paid_blocks) * blockSeconds,
    })),
    events: Object.fromEntries(events.map((entry) => [String((entry as any).event_type), Number((entry as any).count)])),
  };
}
