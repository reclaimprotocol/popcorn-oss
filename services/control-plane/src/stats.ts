import { sql } from 'drizzle-orm';
import { db } from './db';

export interface SessionWindowStats {
  windowHours: number;
  created: number;
  deleted: number;
  expired: number;
  ended: number;
  avgDurationSeconds: number;
  p50DurationSeconds: number;
  p95DurationSeconds: number;
  totalDurationSeconds: number;
}

export interface SessionAllocationStats {
  measuredSessions: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface ViewerRttStats {
  // Sessions carrying a viewerRtt summary — makes partial coverage explicit
  // (the probe only runs on viewers that connect through /kbd).
  measuredSessions: number;
  totalSamples: number;
  avgRttMs: number;
  p50RttMs: number;
  p95RttMs: number;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SessionOverviewStats {
  window: SessionWindowStats;
  allocation: SessionAllocationStats;
  viewerRtt: ViewerRttStats;
}

// Scan sessions ending in the window once for lifecycle metrics and sessions
// created in the window once for demand, allocation, and viewer RTT metrics.
// Previously those created rows were read three separate times.
export async function getSessionOverviewStats(windowHours = 1): Promise<SessionOverviewStats> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const rows = (await db.execute(sql`
    WITH ended_agg AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'deleted') AS deleted,
        COUNT(*) FILTER (WHERE status = 'expired') AS expired,
        COUNT(*) AS ended,
        COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - created_at))), 0) AS avg_duration_s,
        COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - created_at))), 0) AS total_duration_s,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (ended_at - created_at))), 0) AS p50_duration_s,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (ended_at - created_at))), 0) AS p95_duration_s
      FROM sessions
      WHERE ended_at IS NOT NULL
        AND ended_at >= NOW() - make_interval(hours => ${hours})
    ),
    created_agg AS (
      SELECT
        COUNT(*) AS created,
        COUNT(allocation_latency_ms) AS allocation_measured_sessions,
        COALESCE(AVG(allocation_latency_ms), 0) AS avg_latency_ms,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY allocation_latency_ms
        ) FILTER (WHERE allocation_latency_ms IS NOT NULL), 0) AS p50_latency_ms,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (
          ORDER BY allocation_latency_ms
        ) FILTER (WHERE allocation_latency_ms IS NOT NULL), 0) AS p95_latency_ms,
        COUNT(viewer_rtt_avg_ms) AS rtt_measured_sessions,
        COALESCE(SUM(viewer_rtt_sample_count), 0) AS rtt_total_samples,
        COALESCE(AVG(viewer_rtt_avg_ms), 0) AS avg_rtt_ms,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY viewer_rtt_p50_ms
        ) FILTER (WHERE viewer_rtt_p50_ms IS NOT NULL), 0) AS p50_rtt_ms,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (
          ORDER BY viewer_rtt_p95_ms
        ) FILTER (WHERE viewer_rtt_p95_ms IS NOT NULL), 0) AS p95_rtt_ms
      FROM sessions
      WHERE created_at >= NOW() - make_interval(hours => ${hours})
    )
    SELECT * FROM ended_agg, created_agg
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0] ?? {};
  return {
    window: {
      windowHours: hours,
      created: toNumber(row.created),
      deleted: toNumber(row.deleted),
      expired: toNumber(row.expired),
      ended: toNumber(row.ended),
      avgDurationSeconds: toNumber(row.avg_duration_s),
      p50DurationSeconds: toNumber(row.p50_duration_s),
      p95DurationSeconds: toNumber(row.p95_duration_s),
      totalDurationSeconds: toNumber(row.total_duration_s),
    },
    allocation: {
      measuredSessions: toNumber(row.allocation_measured_sessions),
      avgLatencyMs: toNumber(row.avg_latency_ms),
      p50LatencyMs: toNumber(row.p50_latency_ms),
      p95LatencyMs: toNumber(row.p95_latency_ms),
    },
    viewerRtt: {
      measuredSessions: toNumber(row.rtt_measured_sessions),
      totalSamples: toNumber(row.rtt_total_samples),
      avgRttMs: toNumber(row.avg_rtt_ms),
      p50RttMs: toNumber(row.p50_rtt_ms),
      p95RttMs: toNumber(row.p95_rtt_ms),
    },
  };
}

export interface RegionViewerRttStat {
  region: string;
  measuredSessions: number;
  avgRttMs: number;
  p50RttMs: number;
  p95RttMs: number;
}

// Session-level viewer RTT grouped by region; percentiles are over the sessions
// within each region, so regions stay comparable regardless of traffic volume.
export async function getSessionRttStatsByRegion(windowHours = 1): Promise<RegionViewerRttStat[]> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const rows = (await db.execute(sql`
    WITH measured AS MATERIALIZED (
      SELECT COALESCE(region, 'unknown') AS key,
             viewer_rtt_avg_ms AS avg_ms,
             viewer_rtt_p50_ms AS p50_ms,
             viewer_rtt_p95_ms AS p95_ms
      FROM sessions
      WHERE created_at >= NOW() - make_interval(hours => ${hours})
        AND viewer_rtt_avg_ms IS NOT NULL
    )
    SELECT
      key,
      COUNT(*) AS measured_sessions,
      COALESCE(AVG(avg_ms), 0) AS avg_rtt_ms,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY p50_ms), 0) AS p50_rtt_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY p95_ms), 0) AS p95_rtt_ms
    FROM measured
    GROUP BY key
    ORDER BY measured_sessions DESC, key ASC
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    region: String(row.key ?? 'unknown'),
    measuredSessions: toNumber(row.measured_sessions),
    avgRttMs: toNumber(row.avg_rtt_ms),
    p50RttMs: toNumber(row.p50_rtt_ms),
    p95RttMs: toNumber(row.p95_rtt_ms),
  }));
}

export interface SessionTimeBucket {
  bucketStart: string;
  created: number;
  deleted: number;
  expired: number;
  ended: number;
  avgDurationSeconds: number;
}

export interface ViewerRttSeriesPoint {
  bucketStart: string;
  measuredSessions: number;
  p50RttMs: number;
  p95RttMs: number;
}

export interface AnalyticsTimeSeries {
  sessions: SessionTimeBucket[];
  viewerRtt: ViewerRttSeriesPoint[];
}

// Bucket lifecycle and RTT trends together. date_bin assigns each row to one
// interval after a single range scan; the prior grid join repeatedly
// materialized the same RTT rows for every bucket and spilled hundreds of MB.
export async function getAnalyticsTimeSeries(windowHours = 1, buckets = 12): Promise<AnalyticsTimeSeries> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const n = Number.isFinite(buckets) && buckets > 0 ? Math.min(48, Math.floor(buckets)) : 12;
  const bucketSeconds = Math.max(1, Math.round((hours * 3600) / n));

  const rows = (await db.execute(sql`
    WITH params AS (
      SELECT NOW() - make_interval(hours => ${hours}) AS window_start,
             NOW() AS window_end,
             make_interval(secs => ${bucketSeconds}) AS bucket_width
    ),
    grid AS (
      SELECT gs AS bucket_start
      FROM params,
           generate_series(window_start, window_end - bucket_width, bucket_width) AS gs
    ),
    ended_rows AS MATERIALIZED (
      SELECT date_bin(p.bucket_width, s.ended_at, p.window_start) AS bucket_start,
             s.status,
             EXTRACT(EPOCH FROM (s.ended_at - s.created_at)) AS duration_s,
             s.viewer_rtt_p50_ms AS rtt_p50_ms,
             s.viewer_rtt_p95_ms AS rtt_p95_ms,
             s.viewer_rtt_avg_ms AS rtt_measured
      FROM sessions s
      CROSS JOIN params p
      WHERE s.ended_at >= p.window_start
        AND s.ended_at < p.window_end
    ),
    ended AS (
      SELECT bucket_start,
             COUNT(*) FILTER (WHERE status = 'deleted') AS deleted,
             COUNT(*) FILTER (WHERE status = 'expired') AS expired,
             COUNT(*) AS ended,
             AVG(duration_s) AS avg_duration_s,
             COUNT(rtt_measured) AS measured_sessions,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY rtt_p50_ms)
               FILTER (WHERE rtt_p50_ms IS NOT NULL) AS p50_rtt_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY rtt_p95_ms)
               FILTER (WHERE rtt_p95_ms IS NOT NULL) AS p95_rtt_ms
      FROM ended_rows
      GROUP BY bucket_start
    ),
    created AS (
      SELECT date_bin(p.bucket_width, s.created_at, p.window_start) AS bucket_start,
             COUNT(*) AS created
      FROM sessions s
      CROSS JOIN params p
      WHERE s.created_at >= p.window_start
        AND s.created_at < p.window_end
      GROUP BY 1
    )
    SELECT g.bucket_start AS bucket_start,
           COALESCE(c.created, 0) AS created,
           COALESCE(e.deleted, 0) AS deleted,
           COALESCE(e.expired, 0) AS expired,
           COALESCE(e.ended, 0) AS ended,
           COALESCE(e.avg_duration_s, 0) AS avg_duration_s,
           COALESCE(e.measured_sessions, 0) AS measured_sessions,
           COALESCE(e.p50_rtt_ms, 0) AS p50_rtt_ms,
           COALESCE(e.p95_rtt_ms, 0) AS p95_rtt_ms
    FROM grid g
    LEFT JOIN ended e USING (bucket_start)
    LEFT JOIN created c USING (bucket_start)
    ORDER BY g.bucket_start
  `)) as unknown as Array<Record<string, unknown>>;

  const bucketStart = (row: Record<string, unknown>) => (
    row.bucket_start instanceof Date
      ? row.bucket_start.toISOString()
      : String(row.bucket_start)
  );

  return {
    sessions: rows.map((row) => ({
      bucketStart: bucketStart(row),
      created: toNumber(row.created),
      deleted: toNumber(row.deleted),
      expired: toNumber(row.expired),
      ended: toNumber(row.ended),
      avgDurationSeconds: toNumber(row.avg_duration_s),
    })),
    viewerRtt: rows.map((row) => ({
      bucketStart: bucketStart(row),
      measuredSessions: toNumber(row.measured_sessions),
      p50RttMs: toNumber(row.p50_rtt_ms),
      p95RttMs: toNumber(row.p95_rtt_ms),
    })),
  };
}

export interface DimensionCount {
  key: string;
  sessions: number;
}

export interface SessionDimensions {
  byRegion: DimensionCount[];
  topClients: DimensionCount[];
}

// Reuse one narrow materialized window for both dimension breakdowns instead
// of scanning the sessions table once per grouping.
export async function getSessionDimensions(windowHours = 1, limit = 8): Promise<SessionDimensions> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 8;
  const rows = (await db.execute(sql`
    WITH recent AS MATERIALIZED (
      SELECT region, client_name
      FROM sessions
      WHERE created_at >= NOW() - make_interval(hours => ${hours})
    ),
    by_region AS (
      SELECT COALESCE(region, 'unknown') AS key, COUNT(*) AS sessions
      FROM recent
      GROUP BY COALESCE(region, 'unknown')
    ),
    top_clients AS (
      SELECT client_name AS key, COUNT(*) AS sessions
      FROM recent
      GROUP BY client_name
      ORDER BY sessions DESC
      LIMIT ${cap}
    )
    SELECT 'region' AS dimension, key, sessions FROM by_region
    UNION ALL
    SELECT 'client' AS dimension, key, sessions FROM top_clients
    ORDER BY dimension, sessions DESC, key
  `)) as unknown as Array<Record<string, unknown>>;

  const mapRow = (row: Record<string, unknown>) => ({
    key: String(row.key),
    sessions: toNumber(row.sessions),
  });
  return {
    byRegion: rows.filter((row) => row.dimension === 'region').map(mapRow),
    topClients: rows.filter((row) => row.dimension === 'client').map(mapRow),
  };
}

export interface ActiveSessionStats {
  active: number;
  stale: number;
}

// Count active and stale sessions in one pass. Live allocation/capacity still
// comes from Agones; these values are the database cross-check.
export async function getActiveSessionStats(maxAgeHours = 24): Promise<ActiveSessionStats> {
  const hours = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24;
  const rows = (await db.execute(sql`
    SELECT COUNT(*) AS active,
           COUNT(*) FILTER (
             WHERE created_at < NOW() - make_interval(hours => ${hours})
           ) AS stale
    FROM sessions
    WHERE status = 'active'
      AND ended_at IS NULL
  `)) as unknown as Array<Record<string, unknown>>;

  return {
    active: toNumber(rows[0]?.active),
    stale: toNumber(rows[0]?.stale),
  };
}
