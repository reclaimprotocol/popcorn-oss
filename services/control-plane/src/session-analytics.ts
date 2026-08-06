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
