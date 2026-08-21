import { describe, expect, test } from 'bun:test';
import { buildSessionAllocationEvent, buildSessionAnalyticsMetadata, normalizeViewerRttSummary } from './session-analytics';

describe('buildSessionAnalyticsMetadata', () => {
  test('records end-to-end and regional allocation milestones', () => {
    const metadata = buildSessionAnalyticsMetadata({
      requestReceivedAt: new Date('2026-07-29T10:00:00.000Z'),
      allocatedAt: new Date('2026-07-29T10:00:01.250Z'),
      attempts: [{
        region: 'asia-south1',
        clusterName: 'gcp-asia-south1-mumbai',
        status: 'success',
        statusCode: 200,
        latencyMs: 1200,
      }],
      regionalSession: {
        allocationRequestedAt: '2026-07-29T10:00:00.050Z',
        gameServerAllocatedAt: '2026-07-29T10:00:00.900Z',
        boundAt: '2026-07-29T10:00:01.100Z',
        gameServerAllocationLatencyMs: 850,
      },
    });

    expect(metadata.allocationLatencyMs).toBe(1250);
    expect(metadata.allocationAttemptCount).toBe(1);
    expect(metadata.regionalAllocationRequestedAt).toBe('2026-07-29T10:00:00.050Z');
    expect(metadata.gameServerAllocatedAt).toBe('2026-07-29T10:00:00.900Z');
    expect(metadata.sessionBoundAt).toBe('2026-07-29T10:00:01.100Z');
    expect(metadata.gameServerAllocationLatencyMs).toBe(850);
  });

  test('builds a structured failed-allocation event', () => {
    const event = buildSessionAllocationEvent({
      sessionId: 'session-2',
      clientId: 'client-1',
      requestReceivedAt: new Date('2026-07-29T10:00:00.000Z'),
      completedAt: new Date('2026-07-29T10:00:00.900Z'),
      outcome: 'failed',
      attempts: [{
        region: 'us-central1',
        clusterName: 'gcp-us-central1-popcorn',
        status: 'failed',
        statusCode: 503,
        latencyMs: 880,
      }],
    });

    expect(event.eventName).toBe('session.allocation');
    expect(event.outcome).toBe('failed');
    expect(event.latencyMs).toBe(900);
    expect(event.attemptCount).toBe(1);
  });
});

describe('normalizeViewerRttSummary', () => {
  test('computes the canonical summary from raw samples', () => {
    const summary = normalizeViewerRttSummary({
      samples: [{ at: 0, rtt: 40 }, { at: 5000, rtt: 60 }, { at: 9000, rtt: 120 }],
    });
    expect(summary).toEqual({
      sampleCount: 3,
      avgMs: (40 + 60 + 120) / 3,
      p50Ms: 60,
      p95Ms: 120,
      maxMs: 120,
    });
  });

  test('accepts a precomputed summary and drops garbage samples', () => {
    const summary = normalizeViewerRttSummary({
      sampleCount: 12,
      avgMs: 48.4,
      p50Ms: 44,
      p95Ms: 130.5,
      maxMs: 310,
    });
    expect(summary?.sampleCount).toBe(12);
    expect(summary?.p95Ms).toBe(130.5);

    // Negative / absurd / non-numeric samples are dropped, not trusted.
    const filtered = normalizeViewerRttSummary({
      samples: [{ at: 0, rtt: -5 }, { at: 1, rtt: 999999 }, { at: 2, rtt: 'x' }, { at: 3, rtt: 70 }],
    });
    expect(filtered).toEqual({
      sampleCount: 1, avgMs: 70, p50Ms: 70, p95Ms: 70, maxMs: 70,
    });
  });

  test('returns null when nothing valid is provided', () => {
    expect(normalizeViewerRttSummary({})).toBeNull();
    expect(normalizeViewerRttSummary({ samples: [{ at: 0, rtt: -1 }] })).toBeNull();
    expect(normalizeViewerRttSummary({ sampleCount: 0 })).toBeNull();
    expect(normalizeViewerRttSummary({ sampleCount: 'many', avgMs: 50 })).toBeNull();
  });
});
