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
