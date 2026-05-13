import type { RegionConfig } from './config';

export interface RegionSelection {
  regions: RegionConfig[];
  error?: string;
}

export interface RegionAttempt {
  region: string;
  clusterName: string;
  status: 'success' | 'failed';
  statusCode?: number;
  error?: string;
}

export function selectRegions(configuredRegions: RegionConfig[], requestedRegions?: unknown): RegionSelection {
  const enabledRegions = configuredRegions.filter((region) => region.enabled);

  if (requestedRegions === undefined) {
    return { regions: enabledRegions };
  }

  if (!Array.isArray(requestedRegions) || requestedRegions.some((region) => typeof region !== 'string' || !region.trim())) {
    return { regions: [], error: 'regions must be a non-empty array of region names' };
  }

  const configuredByName = new Map(configuredRegions.map((region) => [region.name, region]));
  const selected: RegionConfig[] = [];

  for (const rawName of requestedRegions) {
    const name = rawName.trim();
    const region = configuredByName.get(name);
    if (!region) {
      return { regions: [], error: `Unknown region: ${name}` };
    }
    if (!region.enabled) {
      return { regions: [], error: `Region is disabled: ${name}` };
    }
    if (!selected.some((candidate) => candidate.name === name)) {
      selected.push(region);
    }
  }

  return { regions: selected };
}

export function summarizeAttemptError(statusCode: number, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof (body as any).error === 'string') {
    return (body as any).error;
  }
  return `Pool manager returned ${statusCode}`;
}
