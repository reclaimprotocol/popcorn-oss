const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProxyConfig,
  parseProxyUrl,
  sanitizedStatus
} = require('./proxy-config.js');

test('parses an authenticated proxy URL without exposing credentials in status', () => {
  const config = parseProxyUrl('https://proxy-user:p%40ss@proxy.example:8443', 'localhost, *.svc,localhost');

  assert.deepEqual(config, {
    server: { scheme: 'https', host: 'proxy.example', port: 8443 },
    bypassList: ['localhost', '*.svc'],
    credentials: { username: 'proxy-user', password: 'p@ss' }
  });
  assert.deepEqual(sanitizedStatus({ mode: 'proxy', source: 'default', config }), {
    mode: 'default',
    enabled: true,
    server: 'https://proxy.example:8443',
    bypassList: ['localhost', '*.svc'],
    authenticated: true
  });
});

test('accepts the original structured proxy configuration', () => {
  assert.deepEqual(normalizeProxyConfig({ host: 'proxy.example', port: 1080, scheme: 'socks5' }), {
    server: { scheme: 'socks5', host: 'proxy.example', port: 1080 },
    bypassList: ['localhost', '127.0.0.1'],
    credentials: null
  });
});

test('preserves port 8080 as the original structured API default', () => {
  assert.equal(normalizeProxyConfig({ host: 'proxy.example' }).server.port, 8080);
});

test('rejects unsupported schemes and URLs containing paths', () => {
  assert.throws(
    () => parseProxyUrl('ftp://proxy.example:21'),
    (error) => error.code === 'UNSUPPORTED_PROXY_SCHEME'
  );
  assert.throws(
    () => parseProxyUrl('http://proxy.example:8080/not-a-proxy-endpoint'),
    (error) => error.code === 'INVALID_PROXY_URL'
  );
});

test('rejects credentials for SOCKS proxies because Chrome cannot use them', () => {
  assert.throws(
    () => parseProxyUrl('socks5://user:pass@proxy.example:1080'),
    (error) => error.code === 'UNSUPPORTED_PROXY_AUTH'
  );
});

test('direct status does not contain stale proxy details', () => {
  assert.deepEqual(sanitizedStatus({ mode: 'direct', source: 'override' }), {
    mode: 'direct',
    enabled: false,
    authenticated: false
  });
});

test('rejects removal of Chromium loopback bypass rules', () => {
  for (const token of ['<-loopback>', '<-LoopBacK>']) {
    assert.throws(
      () => parseProxyUrl('http://proxy.example:8080', [token]),
      (error) => error.code === 'UNSAFE_PROXY_BYPASS'
    );
  }
});
