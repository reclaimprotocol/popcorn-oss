import { describe, expect, test } from 'bun:test';
import { readCountryProxy } from './proxy-country';

describe('country proxy selection', () => {
  test('accepts a valid ISO 3166-1 alpha-2 country', () => {
    expect(readCountryProxy({ proxy: { country: 'IN' } })).toEqual({ value: { country: 'IN' } });
  });

  test('rejects unknown or non-country region codes', () => {
    expect(readCountryProxy({ proxy: { country: 'ZZ' } })).toHaveProperty('error');
    expect(readCountryProxy({ proxy: { country: 'EU' } })).toHaveProperty('error');
  });
});
