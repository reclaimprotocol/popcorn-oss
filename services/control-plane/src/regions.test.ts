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
});
