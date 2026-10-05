import { describe, expect, test } from 'bun:test';
import { handoffRegionalSession, terminateRegionalSession } from './pool-manager';
import type { RegionConfig } from './config';

const region: RegionConfig = { name: 'fixture', clusterName: 'fixture', publicGatewayUrl: 'http://unused.invalid', poolManagerUrl: 'http://unused.invalid', enabled: true };
const operations = {
  handoff: (target: RegionConfig) => handoffRegionalSession(target, 'session-1', 'owner', 'pod-1', 'fixture-token', AbortSignal.timeout(1000)),
  termination: (target: RegionConfig) => terminateRegionalSession(target, 'session-1', 'owner', 'pod-1', '2026-09-24T00:00:00.000Z', 'fixture-token', AbortSignal.timeout(1000)),
};

describe('bounded regional maintenance transport', () => {
  test.each(Object.entries(operations))('%s cancels an oversized acknowledgement', async (_name, operation) => {
    const savedFetch = globalThis.fetch;
    let cancelled = false;
    try {
      globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
        expect(options.redirect).toBe('error');
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array(4097)); },
          cancel() { cancelled = true; },
        }));
      }) as typeof fetch;
      await expect(operation(region)).rejects.toThrow('Maintenance acknowledgement is too large');
      expect(cancelled).toBe(true);
    } finally { globalThis.fetch = savedFetch; }
  });

  test.each(Object.entries(operations).flatMap(([name, operation]) => [307, 308].map(status => [name, operation, status] as const)))('%s rejects HTTP redirect %s without invoking legacy DELETE', async (_name, operation, status) => {
    let legacyDeletes = 0;
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      requests++;
      if (new URL(request.url).pathname === '/internal/session/session-1') {
        if (request.method === 'DELETE') legacyDeletes++;
        return Response.json({ success: true, deleted: true });
      }
      return new Response(null, { status, headers: { Location: '/internal/session/session-1' } });
    } });
    try {
      await expect(operation({ ...region, poolManagerUrl: `http://127.0.0.1:${server.port}` })).rejects.toThrow();
      expect(requests).toBe(1);
      expect(legacyDeletes).toBe(0);
    } finally { await server.stop(true); }
  });
});
