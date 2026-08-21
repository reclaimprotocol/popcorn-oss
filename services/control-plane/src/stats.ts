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

// Cumulative session stats for the given window.
// - Duration/outcome metrics are keyed off `ended_at` (sessions that ended in the window).
// - `created` is keyed off `created_at` (inflow / demand in the window).
export async function getSessionWindowStats(windowHours = 1): Promise<SessionWindowStats> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;

  const rows = (await db.execute(sql`
    WITH ended AS (
      SELECT status,
             EXTRACT(EPOCH FROM (ended_at - created_at)) AS dur
      FROM sessions
      WHERE ended_at IS NOT NULL
        AND ended_at >= NOW() - make_interval(hours => ${hours})
    ),
    ended_agg AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'deleted')                       AS deleted,
        COUNT(*) FILTER (WHERE status = 'expired')                       AS expired,
        COUNT(*)                                                         AS ended,
        COALESCE(AVG(dur), 0)                                            AS avg_duration_s,
        COALESCE(SUM(dur), 0)                                            AS total_duration_s,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY dur), 0)    AS p50_duration_s,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY dur), 0)   AS p95_duration_s
      FROM ended
    ),
    created_agg AS (
      SELECT COUNT(*) AS created
      FROM sessions
      WHERE created_at >= NOW() - make_interval(hours => ${hours})
    )
    SELECT * FROM ended_agg, created_agg
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0] ?? {};
  return {
    windowHours: hours,
    created: toNumber(row.created),
    deleted: toNumber(row.deleted),
    expired: toNumber(row.expired),
    ended: toNumber(row.ended),
    avgDurationSeconds: toNumber(row.avg_duration_s),
    p50DurationSeconds: toNumber(row.p50_duration_s),
    p95DurationSeconds: toNumber(row.p95_duration_s),
    totalDurationSeconds: toNumber(row.total_duration_s),
  };
}

// Allocation latency is stored in session metadata so this remains backwards
// compatible with existing rows. measuredSessions makes partial rollout
// coverage explicit instead of silently mixing measured and unmeasured data.
export async function getSessionAllocationStats(windowHours = 1): Promise<SessionAllocationStats> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const rows = (await db.execute(sql`
    WITH measured AS (
      SELECT (metadata->>'allocationLatencyMs')::double precision AS latency_ms
      FROM sessions
      WHERE created_at >= NOW() - make_interval(hours => ${hours})
        AND jsonb_typeof(metadata->'allocationLatencyMs') = 'number'
    )
    SELECT
      COUNT(*) AS measured_sessions,
      COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms), 0) AS p50_latency_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) AS p95_latency_ms
    FROM measured
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0] ?? {};
  return {
    measuredSessions: toNumber(row.measured_sessions),
    avgLatencyMs: toNumber(row.avg_latency_ms),
    p50LatencyMs: toNumber(row.p50_latency_ms),
    p95LatencyMs: toNumber(row.p95_latency_ms),
  };
}

// Viewer-measured tunnel RTT (metadata.viewerRtt). Each session contributes its
// own avg/p50/p95, so fleet percentiles are over sessions, not raw samples — a
// single chatty session cannot dominate the fleet picture.
export async function getSessionRttStats(windowHours = 1): Promise<ViewerRttStats> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(168, windowHours) : 1;
  const rows = (await db.execute(sql`
    WITH measured AS (
      SELECT (metadata->'viewerRtt'->>'avgMs')::double precision AS avg_ms,
             (metadata->'viewerRtt'->>'p50Ms')::double precision AS p50_ms,
             (metadata->'viewerRtt'->>'p95Ms')::double precision AS p95_ms,
             COALESCE((metadata->'viewerRtt'->>'sampleCount')::double precision, 0) AS samples
      FROM sessions
      WHERE created_at >= NOW() - make_interval(hours => ${hours})
        AND jsonb_typeof(metadata->'viewerRtt') = 'object'
        AND jsonb_typeof(metadata->'viewerRtt'->'avgMs') = 'number'
    )
    SELECT
      COUNT(*) AS measured_sessions,
      COALESCE(SUM(samples), 0) AS total_samples,
      COALESCE(AVG(avg_ms), 0) AS avg_rtt_ms,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY p50_ms), 0) AS p50_rtt_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY p95_ms), 0) AS p95_rtt_ms
    FROM measured
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0] ?? {};
  return {
    measuredSessions: toNumber(row.measured_sessions),
    totalSamples: toNumber(row.total_samples),
    avgRttMs: toNumber(row.avg_rtt_ms),
    p50RttMs: toNumber(row.p50_rtt_ms),
    p95RttMs: toNumber(row.p95_rtt_ms),
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
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(168, windowHours) : 1;
  const rows = (await db.execute(sql`
    WITH measured AS (
      SELECT COALESCE(region, 'unknown') AS key,
             (metadata->'viewerRtt'->>'avgMs')::double precision AS avg_ms,
             (metadata->'viewerRtt'->>'p50Ms')::double precision AS p50_ms,
             (metadata->'viewerRtt'->>'p95Ms')::double precision AS p95_ms
      FROM sessions
      WHERE created_at >= NOW() - make_interval(hours => ${hours})
        AND jsonb_typeof(metadata->'viewerRtt') = 'object'
        AND jsonb_typeof(metadata->'viewerRtt'->'avgMs') = 'number'
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

// Time-bucketed session activity across the window, for trend charts.
// Buckets are generated so empty intervals appear as zeros (no gaps).
// `ended`/`deleted`/`expired`/duration are keyed off ended_at; `created` off created_at.
export async function getSessionTimeSeries(windowHours = 1, buckets = 12): Promise<SessionTimeBucket[]> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const n = Number.isFinite(buckets) && buckets > 0 ? Math.min(48, Math.floor(buckets)) : 12;
  const bucketSeconds = Math.max(1, Math.round((hours * 3600) / n));

  const rows = (await db.execute(sql`
    WITH params AS (
      SELECT NOW() - make_interval(hours => ${hours}) AS window_start,
             NOW() AS window_end
    ),
    grid AS (
      SELECT gs AS bucket_start
      FROM params,
           generate_series(
             (SELECT window_start FROM params),
             (SELECT window_end FROM params) - make_interval(secs => ${bucketSeconds}),
             make_interval(secs => ${bucketSeconds})
           ) AS gs
    ),
    ended AS (
      SELECT g.bucket_start,
             COUNT(s.session_id) FILTER (WHERE s.status = 'deleted')          AS deleted,
             COUNT(s.session_id) FILTER (WHERE s.status = 'expired')          AS expired,
             COUNT(s.session_id)                                              AS ended,
             COALESCE(AVG(EXTRACT(EPOCH FROM (s.ended_at - s.created_at))), 0) AS avg_duration_s
      FROM grid g
      LEFT JOIN sessions s
        ON s.ended_at IS NOT NULL
       AND s.ended_at >= g.bucket_start
       AND s.ended_at < g.bucket_start + make_interval(secs => ${bucketSeconds})
      GROUP BY g.bucket_start
    ),
    created AS (
      SELECT g.bucket_start,
             COUNT(s.session_id) AS created
      FROM grid g
      LEFT JOIN sessions s
        ON s.created_at >= g.bucket_start
       AND s.created_at < g.bucket_start + make_interval(secs => ${bucketSeconds})
      GROUP BY g.bucket_start
    )
    SELECT e.bucket_start AS bucket_start,
           e.deleted, e.expired, e.ended, e.avg_duration_s,
           c.created
    FROM ended e
    JOIN created c USING (bucket_start)
    ORDER BY e.bucket_start
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    bucketStart: row.bucket_start instanceof Date
      ? row.bucket_start.toISOString()
      : String(row.bucket_start),
    created: toNumber(row.created),
    deleted: toNumber(row.deleted),
    expired: toNumber(row.expired),
    ended: toNumber(row.ended),
    avgDurationSeconds: toNumber(row.avg_duration_s),
  }));
}

export interface ViewerRttSeriesPoint {
  bucketStart: string;
  measuredSessions: number;
  p50RttMs: number;
  p95RttMs: number;
}

// Viewer RTT over time. Summaries are written at teardown, so each session
// lands in the bucket its ended_at falls into (like the duration trend).
export async function getViewerRttTimeSeries(windowHours = 1, buckets = 12): Promise<ViewerRttSeriesPoint[]> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(168, windowHours) : 1;
  const n = Number.isFinite(buckets) && buckets > 0 ? Math.min(48, Math.floor(buckets)) : 12;
  const bucketSeconds = Math.max(1, Math.round((hours * 3600) / n));

  const rows = (await db.execute(sql`
    WITH params AS (
      SELECT NOW() - make_interval(hours => ${hours}) AS window_start,
             NOW() AS window_end
    ),
    grid AS (
      SELECT gs AS bucket_start
      FROM params,
           generate_series(
             (SELECT window_start FROM params),
             (SELECT window_end FROM params) - make_interval(secs => ${bucketSeconds}),
             make_interval(secs => ${bucketSeconds})
           ) AS gs
    )
    SELECT g.bucket_start AS bucket_start,
           COUNT(s.session_id) AS measured_sessions,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (s.metadata->'viewerRtt'->>'p50Ms')::double precision), 0) AS p50_rtt_ms,
           COALESCE(percentile_cont(0.95) WITHIN GROUP (
             ORDER BY (s.metadata->'viewerRtt'->>'p95Ms')::double precision), 0) AS p95_rtt_ms
    FROM grid g
    LEFT JOIN sessions s
      ON s.ended_at IS NOT NULL
     AND s.ended_at >= g.bucket_start
     AND s.ended_at < g.bucket_start + make_interval(secs => ${bucketSeconds})
     AND jsonb_typeof(s.metadata->'viewerRtt') = 'object'
     AND jsonb_typeof(s.metadata->'viewerRtt'->'avgMs') = 'number'
    GROUP BY g.bucket_start
    ORDER BY g.bucket_start
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    bucketStart: row.bucket_start instanceof Date
      ? row.bucket_start.toISOString()
      : String(row.bucket_start),
    measuredSessions: toNumber(row.measured_sessions),
    p50RttMs: toNumber(row.p50_rtt_ms),
    p95RttMs: toNumber(row.p95_rtt_ms),
  }));
}

export interface DimensionCount {
  key: string;
  sessions: number;
}

// Sessions created in the window grouped by region (usage distribution).
export async function getSessionsByRegion(windowHours = 1): Promise<DimensionCount[]> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const rows = (await db.execute(sql`
    SELECT COALESCE(region, 'unknown') AS key, COUNT(*) AS sessions
    FROM sessions
    WHERE created_at >= NOW() - make_interval(hours => ${hours})
    GROUP BY COALESCE(region, 'unknown')
    ORDER BY sessions DESC
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({ key: String(row.key), sessions: toNumber(row.sessions) }));
}

// Top clients by sessions created in the window.
export async function getTopClients(windowHours = 1, limit = 8): Promise<DimensionCount[]> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 1;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 8;
  const rows = (await db.execute(sql`
    SELECT client_name AS key, COUNT(*) AS sessions
    FROM sessions
    WHERE created_at >= NOW() - make_interval(hours => ${hours})
    GROUP BY client_name
    ORDER BY sessions DESC
    LIMIT ${cap}
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({ key: String(row.key), sessions: toNumber(row.sessions) }));
}

// Count of sessions currently marked active (DB view of allocation).
// Live allocation/capacity should be read from Agones; this is a cross-check.
export async function getActiveSessionCount(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*) AS active
    FROM sessions
    WHERE status = 'active' AND ended_at IS NULL
  `)) as unknown as Array<Record<string, unknown>>;

  return toNumber(rows[0]?.active);
}

export async function getStaleActiveSessionCount(maxAgeHours = 24): Promise<number> {
  const hours = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24;
  const rows = (await db.execute(sql`
    SELECT COUNT(*) AS stale
    FROM sessions
    WHERE status = 'active'
      AND ended_at IS NULL
      AND created_at < NOW() - make_interval(hours => ${hours})
  `)) as unknown as Array<Record<string, unknown>>;

  return toNumber(rows[0]?.stale);
}
