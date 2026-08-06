import { describe, expect, test } from 'bun:test';
import {
  expiresAtFromTtlSeconds,
  extendExpiresAt,
  readOptionalSeconds,
  readTtlConfig,
  validateTtlSeconds,
} from './ttl';

describe('session ttl helpers', () => {
  test('reads max ttl with a 900 second default', () => {
    expect(readTtlConfig({}).maxTtlSeconds).toBe(900);
    expect(readTtlConfig({ SESSION_MAX_TTL_SECONDS: '1200' }).maxTtlSeconds).toBe(1200);
    expect(readTtlConfig({ SESSION_MAX_TTL_SECONDS: 'nope' }).maxTtlSeconds).toBe(900);
  });

  test('validates optional positive integer seconds', () => {
    expect(readOptionalSeconds({}, 'ttlSeconds')).toBeUndefined();
    expect(readOptionalSeconds({ ttlSeconds: 60 }, 'ttlSeconds')).toBe(60);
    expect(readOptionalSeconds({ ttlSeconds: 0 }, 'ttlSeconds')).toBeNull();
    expect(readOptionalSeconds({ ttlSeconds: 1.5 }, 'ttlSeconds')).toBeNull();
    expect(validateTtlSeconds(60, 120, 'ttlSeconds')).toBeNull();
    expect(validateTtlSeconds(121, 120, 'ttlSeconds')).toBe('ttlSeconds must be less than or equal to 120');
    expect(validateTtlSeconds(null, 120, 'ttlSeconds')).toBe('ttlSeconds must be a positive integer');
  });

  test('computes expiry from ttl seconds', () => {
    expect(expiresAtFromTtlSeconds(60, new Date('2026-05-26T12:00:00.000Z'))).toBe('2026-05-26T12:01:00.000Z');
  });

  test('extends from the later of now or current expiry', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');
    expect(extendExpiresAt('2026-05-26T12:05:00.000Z', 60, now)).toBe('2026-05-26T12:06:00.000Z');
    expect(extendExpiresAt('2026-05-26T11:55:00.000Z', 60, now)).toBe('2026-05-26T12:01:00.000Z');
    expect(extendExpiresAt(undefined, 60, now)).toBe('2026-05-26T12:01:00.000Z');
  });
});
