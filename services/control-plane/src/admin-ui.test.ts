import { describe, expect, test } from 'bun:test';
import { renderAnalyticsViewHtml, renderClientsViewHtml, renderClustersViewHtml, renderShellHtml, type AdminView } from './admin-ui';

const views: Array<{ view: AdminView; pagePath: string; fragmentPath: string }> = [
  { view: 'clients', pagePath: '/admin/clients', fragmentPath: '/admin/ui/clients' },
  { view: 'clusters', pagePath: '/admin/clusters', fragmentPath: '/admin/ui/clusters' },
  { view: 'analytics', pagePath: '/admin/analytics', fragmentPath: '/admin/ui/analytics' },
];

describe('admin shell navigation', () => {
  test.each(views)('loads and marks the $view route as active', async ({ view, pagePath, fragmentPath }) => {
    const html = await renderShellHtml(view);

    expect(html).toContain(`class="tab-button active" data-tab="${view}" href="${pagePath}"`);
    expect(html).toContain(`hx-push-url="${pagePath}"`);
    expect(html).toContain(`id="admin-content" hx-get="${fragmentPath}"`);
  });

  test('preserves a selected region when the clusters page is loaded directly', async () => {
    const html = await renderShellHtml('clusters', '/admin/ui/clusters?region=us-central1');
    expect(html).toContain('id="admin-content" hx-get="/admin/ui/clusters?region=us-central1"');
  });

  test('links every view to a refreshable page URL', async () => {
    const html = await renderShellHtml();

    for (const { pagePath } of views) {
      expect(html).toContain(`href="${pagePath}"`);
    }
  });

  test('prioritizes analytics, then clusters, then clients in navigation', async () => {
    const html = await renderShellHtml();
    const analytics = html.indexOf('data-tab="analytics"');
    const clusters = html.indexOf('data-tab="clusters"');
    const clients = html.indexOf('data-tab="clients"');

    expect(analytics).toBeGreaterThan(-1);
    expect(analytics).toBeLessThan(clusters);
    expect(clusters).toBeLessThan(clients);
    expect(html).toContain('class="tab-button active" data-tab="analytics"');
  });

  test('uses the redesigned sidebar shell and responsive workspace navigation', async () => {
    const html = await renderShellHtml('clients');

    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="app-sidebar"');
    expect(html).toContain('class="mobile-header"');
    expect(html).toContain('class="environment-chip"');
    expect(html).toContain('hx-swap="innerHTML scroll:top"');
  });

  test('includes favicon, app icon, and browser theme metadata', async () => {
    const html = await renderShellHtml();

    expect(html).toContain('rel="icon" type="image/svg+xml" href="/admin/assets/site-icon.svg?v=brand-kernel-1"');
    expect(html).toContain('rel="icon" href="/favicon.ico?v=brand-kernel-1"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="theme-color" content="#0b0c0f"');
    expect(html).toContain('class="brand-mark"');
  });
});

const clientViewBase = {
  sessions: [],
  pagination: { limit: 50, offset: 0, hasMore: false, nextOffset: null, previousOffset: null },
  clusters: [
    { regionName: 'us-central1', clusterName: 'gcp-us-central1-popcorn', enabled: true },
    { regionName: 'europe-west4', clusterName: 'gcp-europe-west4-popcorn', enabled: false },
  ],
};

describe('client cluster access controls', () => {
  test('creates clients with selected-cluster mode and an empty safe default', async () => {
    const html = await renderClientsViewHtml({ ...clientViewBase, clients: [] });

    expect(html).toContain('clients-table-panel');
    expect(html).toContain('Client directory');
    expect(html).toContain('data-dialog-open="create-client-dialog"');
    expect(html).toContain('id="create-client-dialog" class="admin-dialog"');
    expect(html).toContain('name="clusterAccessMode" value="selected" checked');
    expect(html).toContain('Leaving every cluster unchecked denies new sessions.');
    expect(html).toContain('value="gcp-us-central1-popcorn"');
    expect(html).not.toContain('x402-us-central1');
  });

  test('shows legacy null access distinctly and requires explicit all-cluster confirmation', async () => {
    const html = await renderClientsViewHtml({
      ...clientViewBase,
      selectedClientId: 'client_legacy',
      clients: [{
        id: 'client_legacy',
        name: 'Legacy client',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        active: true,
        allowedClusters: null,
      }],
    });

    expect(html).toContain('All normal clusters (legacy)');
    expect(html).toContain('name="clusterAccessMode" value="all" checked');
    expect(html).toContain('name="confirmAllClusters" value="yes"');
    expect(html).toContain('every current and future normal cluster');
  });

  test('checks explicit selections and disables editing for reserved clients', async () => {
    const selectedHtml = await renderClientsViewHtml({
      ...clientViewBase,
      selectedClientId: 'client_scoped',
      clients: [{
        id: 'client_scoped',
        name: 'Scoped client',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        active: true,
        allowedClusters: ['gcp-us-central1-popcorn'],
      }],
    });
    expect(selectedHtml).toMatch(/value="gcp-us-central1-popcorn" checked/);
    expect(selectedHtml).toContain('hx-patch="/admin/ui/clients/client_scoped/access"');
    expect(selectedHtml).toContain('data-dialog-open="client-access-client_scoped"');

    const reservedHtml = await renderClientsViewHtml({
      ...clientViewBase,
      selectedClientId: 'x402-public',
      clients: [{
        id: 'x402-public',
        name: 'Public x402',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        active: true,
        allowedClusters: [],
      }],
    });
    expect(reservedHtml).toContain('Built-in system client access cannot be changed here.');
    expect(reservedHtml).toContain('<fieldset disabled="">');
  });
});

describe('cluster workspace layout', () => {
  test('uses a scalable region selector and filterable pod inventory', async () => {
    const html = await renderClustersViewHtml({
      selectedRegion: 'us-central1',
      regions: [{
        name: 'us-central1',
        clusterName: 'gcp-us-central1-popcorn',
        enabled: true,
        publicGatewayUrl: 'http://localhost:8080',
        healthy: true,
        servers: [{ name: 'browser-pod-01', status: 'Allocated', sessionId: 'session-01' }],
        error: null,
      }],
    });

    expect(html).toContain('class="clusters-layout-flat"');
    expect(html).toContain('class="cluster-command-bar"');
    expect(html).toContain('id="region-scope-select"');
    expect(html).toContain('data-pod-inventory');
    expect(html).toContain('data-pod-search');
    expect(html).toContain('data-pod-status');
    expect(html).toContain('data-pod-status-value="allocated"');
    expect(html).toContain('data-dialog-open="create-pod-dialog"');
    expect(html).toContain('class="cluster-operations"');
    expect(html).not.toContain('class="region-tabs"');
    expect(html).not.toContain('class="region-rail"');
    expect(html).not.toContain('class="cluster-detail-stack"');
  });

  test('keeps every region available without rendering an expanding tab strip', async () => {
    const regions = Array.from({ length: 24 }, (_, index) => ({
      name: `region-${index + 1}`,
      clusterName: `cluster-${index + 1}`,
      enabled: true,
      publicGatewayUrl: `https://region-${index + 1}.example.test`,
      healthy: true,
      servers: [],
      error: null,
    }));
    const html = await renderClustersViewHtml({ regions });
    const scopeStart = html.indexOf('id="region-scope-select"');
    const scopeMarkup = html.slice(scopeStart, html.indexOf('</select>', scopeStart));
    expect((scopeMarkup.match(/<option value="region-/g) || []).length).toBe(24);
    expect(html).not.toContain('class="region-tab');
  });
});

describe('analytics duration trend', () => {
  test('explains bucket size and distinguishes the weighted window average', async () => {
    const series = Array.from({ length: 15 }, (_, index) => ({
      bucketStart: new Date(Date.UTC(2026, 6, 6 + index * 2)).toISOString(),
      created: 10,
      deleted: index === 5 ? 0 : 8,
      expired: index === 5 ? 0 : 2,
      ended: index === 5 ? 0 : 10,
      avgDurationSeconds: index === 5 ? 0 : 240 + index * 5,
    }));
    const html = await renderAnalyticsViewHtml({
      data: {
        windowHours: 720,
        configuredTtlSeconds: 3600,
        live: { allocated: 2, ready: 3, capacity: 5, activeSessions: 2, staleActiveSessions: 0 },
        throughput: { sessionsPerMinute: 0.1 },
        allocation: { measuredSessions: 10, avgLatencyMs: 500, p50LatencyMs: 420, p95LatencyMs: 900 },
        viewerRtt: { measuredSessions: 8, totalSamples: 640, avgRttMs: 62, p50RttMs: 55, p95RttMs: 140 },
        viewerRttByRegion: [],
        viewerRttSeries: [],
        window: {
          created: 150,
          deleted: 112,
          expired: 28,
          ended: 140,
          avgDurationSeconds: 373,
          p50DurationSeconds: 157,
          p95DurationSeconds: 904,
          totalDurationSeconds: 52220,
        },
        byRegion: [],
        topClients: [],
        series,
      },
    });

    expect(html).toContain('Session duration trend');
    expect(html).toContain('2-day buckets');
    expect(html).toContain('last 30 days avg · 6m 13s');
    expect(html).toContain('Average of sessions ending in each bucket');
    expect(html).toContain('Empty buckets are left blank');
    expect(html).toContain('stroke-dasharray="5 5"');
  });
});

describe('analytics viewer RTT', () => {
  const baseData = {
    windowHours: 1,
    configuredTtlSeconds: 3600,
    live: { allocated: 2, ready: 3, capacity: 5, activeSessions: 2, staleActiveSessions: 0 },
    throughput: { sessionsPerMinute: 1 },
    allocation: { measuredSessions: 10, avgLatencyMs: 500, p50LatencyMs: 420, p95LatencyMs: 900 },
    window: {
      created: 15, deleted: 11, expired: 2, ended: 13,
      avgDurationSeconds: 373, p50DurationSeconds: 157, p95DurationSeconds: 904,
      totalDurationSeconds: 5222,
    },
    byRegion: [],
    viewerRttByRegion: [],
    viewerRttSeries: [],
    topClients: [],
    series: [],
  };

  test('shows measured RTT percentiles and session coverage', async () => {
    const html = await renderAnalyticsViewHtml({
      data: {
        ...baseData,
        viewerRtt: { measuredSessions: 8, totalSamples: 640, avgRttMs: 62, p50RttMs: 55, p95RttMs: 140 },
      },
    });
    expect(html).toContain('Viewer RTT');
    expect(html).toContain('55 ms');
    expect(html).toContain('p50 · p95 140 ms · 8 sessions');
  });

  test('degrades to an explicit empty state when no sessions were measured', async () => {
    const html = await renderAnalyticsViewHtml({
      data: {
        ...baseData,
        viewerRtt: { measuredSessions: 0, totalSamples: 0, avgRttMs: 0, p50RttMs: 0, p95RttMs: 0 },
      },
    });
    expect(html).toContain('Viewer RTT');
    expect(html).toContain('No measured sessions');
  });

  test('renders the per-region RTT breakdown with bars scaled to the slowest region', async () => {
    const html = await renderAnalyticsViewHtml({
      data: {
        ...baseData,
        // The charts grid only renders when the window saw activity.
        series: [{ bucket: '2026-08-22T00:00:00Z', created: 3, deleted: 2, expired: 0, ended: 2, avgDurationSeconds: 120 }],
        viewerRtt: { measuredSessions: 12, totalSamples: 900, avgRttMs: 90, p50RttMs: 80, p95RttMs: 300 },
        viewerRttByRegion: [
          { region: 'us-east', measuredSessions: 8, avgRttMs: 60, p50RttMs: 50, p95RttMs: 180 },
          { region: 'ap-south', measuredSessions: 4, avgRttMs: 210, p50RttMs: 200, p95RttMs: 480 },
        ],
      },
    });
    expect(html).toContain('Viewer RTT by region');
    expect(html).toContain('us-east');
    expect(html).toContain('p50 50 ms · p95 180 ms · 8 sessions');
    expect(html).toContain('p50 200 ms · p95 480 ms · 4 sessions');
    // ap-south is the slowest region, so its bar is full width.
    expect(html).toContain('width:100%');
    // us-east at 50/200 p50 scales to a quarter-width bar.
    expect(html).toContain('width:25%');
  });

  test('per-region breakdown shows an explicit empty state', async () => {
    const html = await renderAnalyticsViewHtml({
      data: {
        ...baseData,
        series: [{ bucket: '2026-08-22T00:00:00Z', created: 3, deleted: 2, expired: 0, ended: 2, avgDurationSeconds: 120 }],
        viewerRtt: { measuredSessions: 0, totalSamples: 0, avgRttMs: 0, p50RttMs: 0, p95RttMs: 0 },
        viewerRttByRegion: [],
      },
    });
    expect(html).toContain('Viewer RTT by region');
    expect(html).toContain('No measured sessions in this range.');
  });

  test('compacts large session counts in the KPI hint (exact below 10k)', async () => {
    const html = await renderAnalyticsViewHtml({
      data: {
        ...baseData,
        viewerRtt: { measuredSessions: 99986, totalSamples: 900000, avgRttMs: 124, p50RttMs: 124, p95RttMs: 690 },
        viewerRttByRegion: [
          { region: 'us-east', measuredSessions: 25046, avgRttMs: 60, p50RttMs: 50, p95RttMs: 180 },
          { region: 'eu-west', measuredSessions: 9999, avgRttMs: 90, p50RttMs: 80, p95RttMs: 240 },
        ],
        series: [{ bucket: '2026-08-22T00:00:00Z', created: 3, deleted: 2, expired: 0, ended: 2, avgDurationSeconds: 120 }],
      },
    });
    expect(html).toContain('p50 · p95 690 ms · 100.0k sessions');
    expect(html).toContain('p50 50 ms · p95 180 ms · 25.0k sessions');
    expect(html).toContain('p50 80 ms · p95 240 ms · 9999 sessions');
  });

  test('renders the RTT trend chart with p50 line, p95 band, and blank buckets', async () => {
    const html = await renderAnalyticsViewHtml({
      data: {
        ...baseData,
        series: [{ bucket: '2026-08-22T00:00:00Z', created: 3, deleted: 2, expired: 0, ended: 2, avgDurationSeconds: 120 }],
        viewerRtt: { measuredSessions: 5, totalSamples: 300, avgRttMs: 90, p50RttMs: 80, p95RttMs: 300 },
        viewerRttSeries: [
          { bucketStart: '2026-08-22T00:00:00Z', measuredSessions: 3, p50RttMs: 70, p95RttMs: 220 },
          { bucketStart: '2026-08-22T01:00:00Z', measuredSessions: 0, p50RttMs: 0, p95RttMs: 0 },
          { bucketStart: '2026-08-22T02:00:00Z', measuredSessions: 2, p50RttMs: 110, p95RttMs: 340 },
        ],
      },
    });
    expect(html).toContain('Viewer RTT trend');
    expect(html).toContain('anRttGrad');
    expect(html).toContain('p50 70 ms · p95 220 ms · 3 sessions');
    expect(html).toContain('p50 of sessions ending in each bucket');
    expect(html).toContain('p95 band');
  });

  test('RTT trend chart shows an explicit empty state', async () => {
    const html = await renderAnalyticsViewHtml({
      data: {
        ...baseData,
        series: [{ bucket: '2026-08-22T00:00:00Z', created: 3, deleted: 2, expired: 0, ended: 2, avgDurationSeconds: 120 }],
        viewerRtt: { measuredSessions: 0, totalSamples: 0, avgRttMs: 0, p50RttMs: 0, p95RttMs: 0 },
        viewerRttSeries: [
          { bucketStart: '2026-08-22T00:00:00Z', measuredSessions: 0, p50RttMs: 0, p95RttMs: 0 },
        ],
      },
    });
    expect(html).toContain('Viewer RTT trend');
    expect(html).toContain('No measured sessions in this range');
  });
});

describe('Google sign-in branding', () => {
  test('uses the approved label, multicolor mark, and accessible button name', async () => {
    const html = await Bun.file(new URL('../public/admin-login.html', import.meta.url)).text();
    const css = await Bun.file(new URL('../public/admin.css', import.meta.url)).text();

    expect(html).toContain('aria-label="Sign in with Google"');
    expect(html).toContain('class="google-login-label">Sign in with Google</span>');
    expect(html).toContain('class="login-method-divider" role="separator"><span>or</span>');
    expect(html).toContain("document.getElementById('google-auth').hidden = !config.google;");
    expect(html).not.toContain('Continue with Google');
    for (const color of ['#4285F4', '#34A853', '#FBBC05', '#EA4335']) {
      expect(html).toContain(color);
    }
    expect(css).toContain('background: #fff;');
    expect(css).toContain('border: 1px solid #747775;');
    expect(css).toContain('color: #1f1f1f;');
    expect(css).toContain('font-family: Roboto, Arial, sans-serif;');
    expect(css).toContain('font-size: 14px;');
    expect(css).toContain('line-height: 20px;');
    expect(css).toContain('margin-right: 10px;');
    expect(css).toContain('padding: 0 12px;');
  });
});
