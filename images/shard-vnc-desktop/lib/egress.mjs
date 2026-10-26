import { isIP } from 'node:net';

export function parseExitIP(value) {
  if (typeof value !== 'string') throw new Error('Diagnostic endpoint did not return an IP');
  if (isIP(value)) return value;
  const match = value.match(/^\[([^\]]+)\]:\d+$/) || value.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (match && isIP(match[1])) return match[1];
  throw new Error('Diagnostic endpoint returned an invalid IP');
}

export function proxyConfig(env) {
  if (!env.PROXY_SERVER) throw new Error('PROXY_SERVER is required');
  let server;
  try { server = new URL(env.PROXY_SERVER); }
  catch { throw new Error('PROXY_SERVER is invalid'); }
  if (!['http:', 'https:'].includes(server.protocol)
      || server.username || server.password || server.pathname !== '/' || server.search || server.hash) {
    throw new Error('Use an HTTP(S) proxy server, with credentials in separate environment variables');
  }
  if (!env.PROXY_USERNAME) throw new Error('PROXY_USERNAME is required');
  if (!env.PROXY_PASSWORD) throw new Error('PROXY_PASSWORD is required');
  return {
    server: server.origin,
    username: env.PROXY_USERNAME,
    password: env.PROXY_PASSWORD,
  };
}

export function proxyAuthResponse(challenge, config, repeated = false) {
  let matches = false;
  try {
    const origin = new URL(challenge.origin);
    const upstream = new URL(config.server);
    const port = url => url.port || (url.protocol === 'https:' ? '443' : '80');
    matches = challenge.source === 'Proxy' && origin.hostname === upstream.hostname && port(origin) === port(upstream);
  } catch { /* Never supply proxy credentials to an unrecognized challenge. */ }
  if (!matches) return { response: 'Default' };
  if (repeated) return { response: 'CancelAuth' };
  return { response: 'ProvideCredentials', username: config.username, password: config.password };
}

export function normalizeTLS(tls) {
  if (!Array.isArray(tls?.ciphers) || !tls.ciphers.length || !Array.isArray(tls.extensions)) {
    throw new Error('Missing TLS handshake details');
  }
  const extensions = tls.extensions;
  const values = (id, field) => extensions.find(extension => extension.name?.endsWith('(' + id + ')'))?.[field] || [];
  // Some diagnostics render signature GREASE as raw hex rather than a name.
  // RFC 8701 reserves exactly 0x0a0a, 0x1a1a, ... 0xfafa; keep real algorithms.
  const withoutGrease = list => list.filter(value => !/GREASE/i.test(value)
    && !/^0x([0-9a-f]a)\1$/i.test(String(value)));
  // Chrome randomizes extension order and GREASE values. TLS 1.3 resumption
  // adds pre_shared_key (41), changing JA4 without changing the client profile.
  // Keep every other extension and ordered capability list in the comparison.
  return {
    version: tls.tls_version_negotiated,
    ciphers: withoutGrease(tls.ciphers),
    extensions: extensions.map(extension => extension.name).filter(name => !/GREASE/i.test(name)
      && !name.endsWith('(41)')).sort(),
    groups: withoutGrease(values(10, 'supported_groups')),
    versions: withoutGrease(values(43, 'versions')),
    signatures: withoutGrease(values(13, 'signature_algorithms')),
    alpn: values(16, 'protocols'),
  };
}

export function tlsSummary(data) {
  if (!data?.tls?.ja4 || !data.http2?.akamai_fingerprint) throw new Error('Incomplete TLS/HTTP2 diagnostic response');
  const headers = (data.http2.sent_frames || []).filter(frame => frame.frame_type === 'HEADERS')
    .flatMap(frame => frame.headers || []);
  const userAgent = data.user_agent || '';
  const major = userAgent.match(/Chrome\/(\d+)\./)?.[1];
  const brands = headers.find(header => /^sec-ch-ua: /i.test(header)) || '';
  const versions = [...brands.matchAll(/"(?:Chromium|Google Chrome)";v="(\d+)"/g)].map(match => match[1]);
  const platform = headers.find(header => /^sec-ch-ua-platform: /i.test(header)) || '';
  const expectedPlatform = /Windows NT/.test(userAgent) ? 'Windows' : /Macintosh/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : null;
  if (!major || !versions.length || versions.some(version => version !== major)
      || !expectedPlatform || !platform.includes('"' + expectedPlatform + '"')) {
    throw new Error('User-Agent and transmitted Client Hints disagree');
  }
  return {
    ip: parseExitIP(data.ip), ja4: data.tls.ja4, tlsProfile: normalizeTLS(data.tls),
    resumptionOffered: data.tls.extensions.some(extension => extension.name?.endsWith('(41)')), httpVersion: data.http_version,
    http2Fingerprint: data.http2.akamai_fingerprint, userAgent,
    headers: headers.filter(header => /^(user-agent|sec-ch-ua[^:]*|accept-language):/i.test(header)),
  };
}

export function verifyEgress(samples, baseline) {
  if (samples.length < 4 || !samples.some(sample => sample.endpoint === 'ipify')
      || samples.filter(sample => sample.endpoint === 'tls').length < 2) {
    throw new Error('Need repeated measurements from both diagnostic endpoints');
  }
  const addresses = samples.map(sample => parseExitIP(sample.ip));
  if (new Set(addresses).size !== 1) throw new Error('Proxy exit changed between diagnostic requests; site navigation withheld');
  if (addresses[0] === parseExitIP(baseline.ip)) throw new Error('Proxy exit matches direct egress; site navigation withheld');
  for (const sample of samples.filter(sample => sample.endpoint === 'tls')) {
    if (!sample.tlsProfile || !baseline.tlsProfile
        || JSON.stringify(sample.tlsProfile) !== JSON.stringify(baseline.tlsProfile) || sample.httpVersion !== baseline.httpVersion
        || sample.http2Fingerprint !== baseline.http2Fingerprint
        || (baseline.userAgent && sample.userAgent !== baseline.userAgent)) {
      throw new Error('Proxy changed the measured TLS/HTTP2 fingerprint; site navigation withheld');
    }
  }
  return addresses[0];
}
