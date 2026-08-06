import { describe, expect, test } from 'bun:test';
import { buildSessionAllocationEvent, buildSessionAnalyticsMetadata } from './session-analytics';

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
