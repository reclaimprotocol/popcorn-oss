import { expect, test } from 'bun:test';

test('admin responses enforce a same-origin, external-script CSP', async () => {
  const child = Bun.spawn([
    'bun',
    '-e',
    `const app = (await import('./index.ts')).default;
     const paths = ['/admin/login', '/admin/sessions', '/admin/assets/admin-login.js', '/admin/assets/admin.js', '/admin/assets/htmx.min.js'];
     const responses = await Promise.all(paths.map(async (path) => {
       const response = await app.fetch(new Request('http://localhost' + path));
       return { path, status: response.status, csp: response.headers.get('Content-Security-Policy'), contentType: response.headers.get('Content-Type'), body: await response.text() };
     }));
     console.log('CSP_TEST_RESULT:' + JSON.stringify(responses));`,
  ], {
    cwd: import.meta.dir + '/..',
    env: {
      ...process.env,
      CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
      CONTROL_PLANE_REGIONS: '[]',
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const resultLine = stdout.split('\n').find((line) => line.startsWith('CSP_TEST_RESULT:'));
  expect(resultLine).toBeDefined();
  const responses = JSON.parse(resultLine!.slice('CSP_TEST_RESULT:'.length)) as Array<{
    path: string;
    status: number;
    csp: string;
    contentType: string;
    body: string;
  }>;
  for (const response of responses) {
    expect(response.csp.split('; ').find((directive) => directive.startsWith('script-src '))).toBe("script-src 'self'");
    expect(response.csp).toContain("object-src 'none'");
    expect(response.csp).not.toContain('unpkg.com');
  }
  expect(responses[0].status).toBe(200);
  expect(responses[0].body).toContain('<script src="/admin/assets/admin-login.js" defer></script>');
  expect(responses[0].body).not.toContain('<script>');
  expect(responses[1].status).toBe(401);
  for (const response of responses.slice(2)) {
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/javascript');
    expect(response.body.length).toBeGreaterThan(0);
  }
});
