import { describe, expect, test } from 'bun:test';
import { readBrowserExit, readCountryProxy } from './proxy-country';

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

describe('caller proxy exit', () => {
  test('is optional', () => {
    expect(readBrowserExit({})).toEqual({});
    expect(readBrowserExit({ browserExit: null })).toEqual({});
  });

  test('accepts a timezone and a public IP', () => {
    expect(readBrowserExit({ browserExit: { timezone: 'Asia/Dubai', publicIp: '192.0.2.44' } }))
      .toEqual({ value: { timezone: 'Asia/Dubai', publicIp: '192.0.2.44' } });
    expect(readBrowserExit({ browserExit: { publicIp: '2001:db8::1' } })).toEqual({ value: { publicIp: '2001:db8::1' } });
  });

  test('rejects anything but a zone and an address', () => {
    expect(readBrowserExit({ browserExit: {} })).toHaveProperty('error');
    expect(readBrowserExit({ browserExit: { timezone: '"};rm -rf' } })).toHaveProperty('error');
    expect(readBrowserExit({ browserExit: { publicIp: 'proxy.example' } })).toHaveProperty('error');
    expect(readBrowserExit({ browserExit: { publicIp: '192.0.2.44', server: 'http://user:pass@proxy.example:80' } })).toHaveProperty('error');
  });

  test('cannot be combined with a pool-managed proxy', () => {
    expect(readBrowserExit({ proxy: { country: 'AE' }, browserExit: { timezone: 'Asia/Dubai' } })).toHaveProperty('error');
  });
});
