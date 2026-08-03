import { describe, expect, test } from 'bun:test';
import type { RegionConfig } from './config';
import { selectRegions } from './regions';

const regions: RegionConfig[] = [
  {
    name: 'asia-south1',
    clusterName: 'asia-cluster',
    poolManagerUrl: 'http://pool-asia',
    publicGatewayUrl: 'https://asia.example.com',
    enabled: true,
  },
  {
    name: 'us-central1',
    clusterName: 'us-cluster',
    poolManagerUrl: 'http://pool-us',
    publicGatewayUrl: 'https://us.example.com',
    enabled: true,
  },
  {
    name: 'europe-west1',
    clusterName: 'eu-cluster',
    poolManagerUrl: 'http://pool-eu',
    publicGatewayUrl: 'https://eu.example.com',
    enabled: false,
  },
  {
    name: 'x402-us-central1',
    clusterName: 'x402-cluster',
    poolManagerUrl: 'https://x402.example.com',
    publicGatewayUrl: 'https://x402.example.com',
    enabled: true,
    x402Only: true,
  },
];

describe('region selection', () => {
  test('uses enabled configured order when no request preference is supplied', () => {
    expect(selectRegions(regions).regions.map((region) => region.name)).toEqual(['asia-south1', 'us-central1']);
  });

  test('uses request priority order', () => {
    expect(selectRegions(regions, ['us-central1', 'asia-south1']).regions.map((region) => region.name)).toEqual([
      'us-central1',
      'asia-south1',
    ]);
  });

  test('rejects unknown regions', () => {
    expect(selectRegions(regions, ['moon-1']).error).toBe('Unknown region: moon-1');
  });

  test('rejects disabled regions', () => {
    expect(selectRegions(regions, ['europe-west1']).error).toBe('Region is disabled: europe-west1');
  });

  test('excludes x402-only regions from credentialed fallback', () => {
    expect(selectRegions(regions).regions.map((region) => region.name)).toEqual(['asia-south1', 'us-central1']);
  });

  test('rejects an explicitly requested x402-only region', () => {
    expect(selectRegions(regions, ['x402-us-central1']).error).toBe(
      'Region is reserved for x402 sessions: x402-us-central1',
    );
  });

  test('filters fallback routing to a client cluster allowlist', () => {
    expect(selectRegions(regions, undefined, ['us-cluster']).regions.map((region) => region.name))
      .toEqual(['us-central1']);
    expect(selectRegions(regions, undefined, []).regions).toEqual([]);
  });

  test('rejects a requested region outside the client cluster allowlist', () => {
    expect(selectRegions(regions, ['asia-south1'], ['us-cluster']).error)
      .toBe('Client is not allowed to use region: asia-south1');
  });

  test('keeps existing clients backward compatible with all routable clusters', () => {
    expect(selectRegions(regions, undefined, null).regions.map((region) => region.name))
      .toEqual(['asia-south1', 'us-central1']);
  });
});
