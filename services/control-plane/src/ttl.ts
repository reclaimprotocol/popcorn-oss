export const DEFAULT_SESSION_MAX_TTL_SECONDS = 900;

export interface TtlConfig {
  maxTtlSeconds: number;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readTtlConfig(env: Record<string, string | undefined> = process.env): TtlConfig {
  return {
    maxTtlSeconds: readPositiveInteger(env.SESSION_MAX_TTL_SECONDS, DEFAULT_SESSION_MAX_TTL_SECONDS),
  };
}

export function readOptionalSeconds(body: any, field: string): number | undefined | null {
  if (!body || typeof body !== 'object' || !(field in body)) {
    return undefined;
  }
  const value = body[field];
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function validateTtlSeconds(seconds: number | undefined | null, maxTtlSeconds: number, field: string): string | null {
  if (seconds === undefined) {
    return null;
  }
  if (seconds === null) {
    return `${field} must be a positive integer`;
  }
  if (seconds > maxTtlSeconds) {
    return `${field} must be less than or equal to ${maxTtlSeconds}`;
  }
  return null;
}

export function expiresAtFromTtlSeconds(ttlSeconds: number, now = new Date()): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

export function extendExpiresAt(currentExpiresAt: string | undefined | null, extendBySeconds: number, now = new Date()): string {
  const current = currentExpiresAt ? Date.parse(currentExpiresAt) : NaN;
  const baseTime = Number.isFinite(current) ? Math.max(now.getTime(), current) : now.getTime();
  return new Date(baseTime + extendBySeconds * 1000).toISOString();
}
