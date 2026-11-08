import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExitIP, proxyAuthResponse, proxyConfig, normalizeTLS, tlsSummary, verifyEgress } from './egress.mjs';
import { captureHAR, sanitizeHeaders, sanitizeURL } from './har.mjs';

const config = proxyConfig({ PROXY_USERNAME: 'brd-customer-test-zone-residential', PROXY_PASSWORD: 'test-password', PROXY_SESSION_ID: 'browser-42' });
const baseline = { ip: '192.0.2.1', ja4: 'chrome-ja4', httpVersion: 'h2', http2Fingerprint: 'chrome-h2', userAgent: 'Chrome/150.0.0.0', tlsProfile: { version: '772', ciphers: ['TLS_AES_128_GCM_SHA256'] } };
const tls = { endpoint: 'tls', ...baseline, ip: '198.51.100.2' };
const samples = [{ endpoint: 'ipify', ip: tls.ip }, tls, { endpoint: 'ipify', ip: tls.ip }, tls];

test('accepts repeated stable egress while rejecting drift, direct leakage and TLS changes', () => {
  assert.equal(verifyEgress(samples, baseline), tls.ip);
  assert.throws(() => verifyEgress([...samples.slice(0, 3), { ...tls, ip: '198.51.100.3' }], baseline), /exit changed/);
  assert.throws(() => verifyEgress(samples, { ...baseline, ip: tls.ip }), /matches direct/);
  assert.throws(() => verifyEgress([...samples.slice(0, 3), { ...tls, tlsProfile: { ...baseline.tlsProfile, version: '771' } }], baseline), /TLS\/HTTP2/);
  assert.throws(() => verifyEgress([...samples.slice(0, 3), { ...tls, userAgent: 'Chrome/149.0.0.0' }], baseline), /TLS\/HTTP2/);
  assert.throws(() => verifyEgress(samples.slice(0, 2), baseline), /repeated measurements/);
});

test('parses real diagnostic IPv4 and bracketed IPv6 endpoints without truncating raw IPv6', () => {
  assert.equal(parseExitIP('198.51.100.2:443'), '198.51.100.2');
  assert.equal(parseExitIP('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(parseExitIP('2001:db8::1'), '2001:db8::1');
  assert.throws(() => parseExitIP('not-an-ip'), /invalid IP/);
});

test('one stable, strict peer is selected per logical browser session', () => {
  assert.equal(config.username, proxyConfig({ PROXY_USERNAME: 'brd-customer-test-zone-residential', PROXY_PASSWORD: 'other', PROXY_SESSION_ID: 'browser-42' }).username);
  assert.match(config.username, /-country-in-session-[a-f0-9]{32}-const$/);
  assert.notEqual(config.username, proxyConfig({ PROXY_USERNAME: 'brd-customer-test-zone-residential', PROXY_PASSWORD: 'test', PROXY_SESSION_ID: 'browser-43' }).username);
  assert.throws(() => proxyConfig({ PROXY_USERNAME: config.username, PROXY_PASSWORD: 'test' }), /without targeting/);
  assert.throws(() => proxyConfig({ PROXY_USERNAME: 'brd-customer-test-zone-residential' }), /PASSWORD/);
});

test('proxy credentials are never supplied to website or unrelated proxy authentication', () => {
  const origin = 'http://brd.superproxy.io:33335';
  assert.equal(proxyAuthResponse({ source: 'Proxy', origin }, config).response, 'ProvideCredentials');
  assert.equal(proxyAuthResponse({ source: 'Proxy', origin }, config, true).response, 'CancelAuth');
  assert.deepEqual(proxyAuthResponse({ source: 'Server', origin }, config), { response: 'Default' });
  assert.deepEqual(proxyAuthResponse({ source: 'Proxy', origin: 'http://other.example:33335' }, config), { response: 'Default' });
  assert.deepEqual(proxyAuthResponse({ source: 'Proxy', origin: 'http://brd.superproxy.io:80' }, config), { response: 'Default' });
});

test('rejects mismatched transmitted UA version or platform', () => {
  const make = (version = '150', platform = 'Windows') => ({
    ip: '198.51.100.2:443', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150.0.0.0', http_version: 'h2',
    tls: { ja4: baseline.ja4, tls_version_negotiated: '772', ciphers: ['TLS_AES_128_GCM_SHA256'], extensions: [] }, http2: { akamai_fingerprint: baseline.http2Fingerprint, sent_frames: [{ frame_type: 'HEADERS', headers: [
      'sec-ch-ua: "Chromium";v="' + version + '"', 'sec-ch-ua-platform: "' + platform + '"',
    ] }] },
  });
  assert.equal(tlsSummary(make()).ip, '198.51.100.2');
  assert.throws(() => tlsSummary(make('149')), /disagree/);
  assert.throws(() => tlsSummary(make('150', 'Linux')), /disagree/);
});

test('redacts credentials, cookie values, queries and auth flow identifiers before capture', () => {
  const headers = sanitizeHeaders({ Cookie: 'a=secret; b=token', Authorization: 'Bearer secret', 'Proxy-Authorization': 'Basic secret',
    'Set-Cookie': 'session=secret; Secure; HttpOnly', 'User-Agent': 'Chrome/150.0.0.0' });
  const serialized = JSON.stringify(headers);
  assert.ok(!serialized.includes('secret') && !serialized.includes('token'));
  assert.ok(serialized.includes('Chrome/150.0.0.0'));
  const url = sanitizeURL('https://user:password@signin.example/pf-ws/authn/flows/live-token?code=secret#fragment');
  assert.ok(!/password|live-token|secret|fragment/.test(url));
  assert.ok(decodeURI(url).includes('[FLOW_ID]'));
});


test('TLS resumption may change JA4 while preserving the measured client profile', () => {
  const original = { tls_version_negotiated: '772', ciphers: ['TLS_GREASE (0xaaaa)', 'TLS_AES_128_GCM_SHA256'],
    extensions: [{ name: 'TLS_GREASE (0xaaaa)' }, { name: 'supported_versions (43)', versions: ['TLS 1.3', 'TLS 1.2'] },
      { name: 'application_layer_protocol_negotiation (16)', protocols: ['h2', 'http/1.1'] }] };
  const resumed = { ...original, ciphers: ['TLS_GREASE (0xbbbb)', 'TLS_AES_128_GCM_SHA256'],
    extensions: [{ name: 'pre_shared_key (41)' }, ...original.extensions.slice(1).reverse(), { name: 'TLS_GREASE (0xbbbb)' }] };
  assert.deepEqual(normalizeTLS(original), normalizeTLS(resumed));
  assert.notDeepEqual(normalizeTLS(original), normalizeTLS({ ...resumed, ciphers: ['TLS_AES_256_GCM_SHA384'] }));
  const changedJA4 = samples.map(sample => sample.endpoint === 'tls' ? { ...sample, ja4: 'resumed-ja4' } : sample);
  assert.equal(verifyEgress(changedJA4, baseline), tls.ip);
});


test('HAR capture omits request bodies and allowlists authentication error responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'popcorn-har-test-'));
  const path = join(directory, 'capture.har');
  let handler;
  const page = {
    onEvent(callback) { handler = callback; return () => {}; },
    async send() { return { body: JSON.stringify({ code: 'VALIDATION_ERROR', message: 'fixture-secret', token: 'fixture-secret' }) }; },
  };
  const stop = await captureHAR(page, path);
  try {
    handler({ method: 'Network.requestWillBeSent', params: { requestId: '1', wallTime: 1, timestamp: 1, type: 'XHR',
      request: { method: 'POST', url: 'https://signin.example/pf-ws/authn/flows/sensitive-flow?token=fixture-secret',
        postData: 'password=fixture-secret', headers: { Cookie: 'session=fixture-secret', Authorization: 'fixture-secret' } } } });
    handler({ method: 'Network.responseReceived', params: { requestId: '1', response: {
      status: 400, statusText: 'Bad Request', protocol: 'h2', mimeType: 'application/json', headers: { 'Set-Cookie': 'session=fixture-secret' },
    } } });
    handler({ method: 'Network.loadingFinished', params: { requestId: '1', timestamp: 2 } });
    await Promise.resolve();
    await stop();
    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes('fixture-secret') && !text.includes('sensitive-flow'));
    const entry = JSON.parse(text).log.entries[0];
    assert.equal(entry.request.postData, undefined);
    assert.equal(entry._errorSummary.code, 'VALIDATION_ERROR');
    assert.equal(entry._errorSummary.token, undefined);
    assert.equal(entry._errorSummary.message, undefined);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
