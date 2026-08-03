import { describe, expect, test } from 'bun:test';
import { renderShellHtml, type AdminView } from './admin-ui';

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
