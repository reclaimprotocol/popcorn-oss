import type { RegionAttempt } from './regions';

export interface SessionAnalyticsInput {
  requestReceivedAt: Date;
  allocatedAt: Date;
  attempts: RegionAttempt[];
  regionalSession?: Record<string, unknown>;
}

export interface SessionAllocationEventInput {
  sessionId: string;
  clientId: string;
  requestReceivedAt: Date;
  completedAt: Date;
  outcome: 'success' | 'failed';
  attempts: RegionAttempt[];
  region?: string;
}

export function buildSessionAnalyticsMetadata(input: SessionAnalyticsInput): Record<string, unknown> {
  const allocationLatencyMs = Math.max(0, input.allocatedAt.getTime() - input.requestReceivedAt.getTime());
  const regional = input.regionalSession || {};

  return {
    requestReceivedAt: input.requestReceivedAt.toISOString(),
    allocatedAt: input.allocatedAt.toISOString(),
    allocationLatencyMs,
    allocationAttemptCount: input.attempts.length,
    allocationAttempts: input.attempts,
    ...(typeof regional.allocationRequestedAt === 'string'
      ? { regionalAllocationRequestedAt: regional.allocationRequestedAt }
      : {}),
    ...(typeof regional.gameServerAllocatedAt === 'string'
      ? { gameServerAllocatedAt: regional.gameServerAllocatedAt }
      : {}),
    ...(typeof regional.boundAt === 'string' ? { sessionBoundAt: regional.boundAt } : {}),
    ...(typeof regional.gameServerAllocationLatencyMs === 'number'
      ? { gameServerAllocationLatencyMs: regional.gameServerAllocationLatencyMs }
      : {}),
  };
}

export function buildSessionAllocationEvent(input: SessionAllocationEventInput): Record<string, unknown> {
  return {
    eventName: 'session.allocation',
    sessionId: input.sessionId,
    clientId: input.clientId,
    outcome: input.outcome,
    region: input.region,
    requestReceivedAt: input.requestReceivedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    latencyMs: Math.max(0, input.completedAt.getTime() - input.requestReceivedAt.getTime()),
    attemptCount: input.attempts.length,
    attempts: input.attempts,
  };
}

// Viewer-measured tunnel RTT (see images/minimal-vnc-desktop/kbd/rtt-report.js).
// Samples share the probe's sanity window: [0, 20000) ms.
export interface ViewerRttSummary {
  sampleCount: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

const VIEWER_RTT_MAX_MS = 20000;

function finiteMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n < VIEWER_RTT_MAX_MS ? n : null;
}

function percentile(sorted: number[], pct: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(pct * sorted.length)));
  return sorted[idx];
}

function summarizeRtts(rtts: number[]): ViewerRttSummary {
  const sorted = [...rtts].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  return {
    sampleCount: sorted.length,
    avgMs: sorted.length ? total / sorted.length : 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

// Accepts either a precomputed summary or a raw sample list and returns the
// canonical stored shape; null when nothing valid was provided.
export function normalizeViewerRttSummary(
  body: Record<string, unknown>,
): ViewerRttSummary | null {
  const rawSamples = Array.isArray(body.samples) ? body.samples : null;
  if (rawSamples) {
    const rtts: number[] = [];
    for (const s of rawSamples) {
      if (!s || typeof s !== 'object') continue;
      const rtt = finiteMs((s as Record<string, unknown>).rtt);
      if (rtt !== null) rtts.push(rtt);
    }
    if (!rtts.length) return null;
    return summarizeRtts(rtts);
  }

  const sampleCount = Number(body.sampleCount);
  const avgMs = finiteMs(body.avgMs);
  if (!Number.isFinite(sampleCount) || sampleCount < 1 || avgMs === null) return null;
  const p50Ms = finiteMs(body.p50Ms);
  const p95Ms = finiteMs(body.p95Ms);
  const maxMs = finiteMs(body.maxMs);
  return {
    sampleCount: Math.floor(sampleCount),
    avgMs,
    p50Ms: p50Ms ?? avgMs,
    p95Ms: p95Ms ?? avgMs,
    maxMs: maxMs ?? avgMs,
  };
}
