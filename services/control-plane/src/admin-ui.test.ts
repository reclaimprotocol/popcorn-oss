import { describe, expect, test } from 'bun:test';
import { renderClientsViewHtml, renderShellHtml, type AdminView } from './admin-ui';

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

  test('links every view to a refreshable page URL', async () => {
    const html = await renderShellHtml();

    for (const { pagePath } of views) {
      expect(html).toContain(`href="${pagePath}"`);
    }
  });

  test('includes favicon, app icon, and browser theme metadata', async () => {
    const html = await renderShellHtml();

    expect(html).toContain('rel="icon" type="image/svg+xml" href="/admin/assets/site-icon.svg?v=brand-kernel-1"');
    expect(html).toContain('rel="icon" href="/favicon.ico?v=brand-kernel-1"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="theme-color" content="#0d141b"');
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

    expect(html).toContain('all normal clusters · legacy');
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
