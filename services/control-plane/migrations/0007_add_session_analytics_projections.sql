-- Keep index construction comfortably below the standalone database's legacy
-- 512 MiB limit; the setting is transaction-local to this migration job.
SET LOCAL maintenance_work_mem = '16MB';
--> statement-breakpoint
ALTER TABLE "sessions"
ADD COLUMN IF NOT EXISTS "allocation_latency_ms" double precision
GENERATED ALWAYS AS (
  CASE
    WHEN jsonb_typeof("metadata"->'allocationLatencyMs') = 'number'
    THEN ("metadata"->>'allocationLatencyMs')::double precision
  END
) STORED,
ADD COLUMN IF NOT EXISTS "viewer_rtt_avg_ms" double precision
GENERATED ALWAYS AS (
  CASE
    WHEN jsonb_typeof("metadata"->'viewerRtt') = 'object'
     AND jsonb_typeof("metadata"->'viewerRtt'->'avgMs') = 'number'
    THEN ("metadata"->'viewerRtt'->>'avgMs')::double precision
  END
) STORED,
ADD COLUMN IF NOT EXISTS "viewer_rtt_p50_ms" double precision
GENERATED ALWAYS AS (
  CASE
    WHEN jsonb_typeof("metadata"->'viewerRtt') = 'object'
     AND jsonb_typeof("metadata"->'viewerRtt'->'avgMs') = 'number'
    THEN ("metadata"->'viewerRtt'->>'p50Ms')::double precision
  END
) STORED,
ADD COLUMN IF NOT EXISTS "viewer_rtt_p95_ms" double precision
GENERATED ALWAYS AS (
  CASE
    WHEN jsonb_typeof("metadata"->'viewerRtt') = 'object'
     AND jsonb_typeof("metadata"->'viewerRtt'->'avgMs') = 'number'
    THEN ("metadata"->'viewerRtt'->>'p95Ms')::double precision
  END
) STORED,
ADD COLUMN IF NOT EXISTS "viewer_rtt_sample_count" double precision
GENERATED ALWAYS AS (
  CASE
    WHEN jsonb_typeof("metadata"->'viewerRtt') = 'object'
     AND jsonb_typeof("metadata"->'viewerRtt'->'avgMs') = 'number'
    THEN ("metadata"->'viewerRtt'->>'sampleCount')::double precision
  END
) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_created_analytics_idx"
ON "sessions" (
  "created_at",
  "region",
  "client_name",
  "allocation_latency_ms",
  "viewer_rtt_avg_ms",
  "viewer_rtt_p50_ms",
  "viewer_rtt_p95_ms",
  "viewer_rtt_sample_count"
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_ended_analytics_idx"
ON "sessions" (
  "ended_at",
  "created_at",
  "status",
  "viewer_rtt_avg_ms",
  "viewer_rtt_p50_ms",
  "viewer_rtt_p95_ms"
);
