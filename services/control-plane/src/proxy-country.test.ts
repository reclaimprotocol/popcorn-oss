import { describe, expect, test } from 'bun:test';
import { readCountryProxy } from './proxy-country';

describe('country proxy selection', () => {
  test('treats an omitted, null, or false proxy as direct egress', () => {
    expect(readCountryProxy({})).toEqual({ value: null });
    expect(readCountryProxy({ proxy: null })).toEqual({ value: null });
    expect(readCountryProxy({ proxy: false })).toEqual({ value: null });
  });

  test('accepts a valid ISO 3166-1 alpha-2 country', () => {
    expect(readCountryProxy({ proxy: { country: 'IN' } })).toEqual({ value: { country: 'IN' } });
  });

  test('rejects unknown or non-country region codes', () => {
    expect(readCountryProxy({ proxy: { country: 'ZZ' } })).toHaveProperty('error');
    expect(readCountryProxy({ proxy: { country: 'EU' } })).toHaveProperty('error');
  });

  test('rejects arbitrary proxy connection settings', () => {
    expect(readCountryProxy({ proxy: { country: 'IN', host: 'untrusted.example' } })).toHaveProperty('error');
    expect(readCountryProxy({ proxy: { server: 'http://untrusted.example:8080' } })).toHaveProperty('error');
  });
});
