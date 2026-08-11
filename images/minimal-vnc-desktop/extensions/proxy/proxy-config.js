(function(root, factory) {
  const api = factory();
  root.PopcornProxyConfig = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const supportedSchemes = new Set(['http', 'https', 'socks4', 'socks5']);
  const defaultPorts = Object.freeze({ http: 80, https: 443, socks4: 1080, socks5: 1080 });
  const defaultBypassList = Object.freeze(['localhost', '127.0.0.1']);

  function configError(message, code = 'INVALID_PROXY_CONFIG') {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function decodeComponent(value, label) {
    try {
      return decodeURIComponent(value);
    } catch {
      throw configError(`Proxy ${label} contains invalid URL encoding`, 'INVALID_PROXY_URL');
    }
  }

  function normalizeBypassList(value) {
    const entries = value == null
      ? [...defaultBypassList]
      : Array.isArray(value)
        ? value
        : String(value).split(',');

    const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean);
    if (normalized.some((entry) => entry.toLowerCase() === '<-loopback>')) {
      throw configError('The <-loopback> bypass token is not allowed because proxy control uses loopback', 'UNSAFE_PROXY_BYPASS');
    }
    if (normalized.some((entry) => entry.length > 255)) {
      throw configError('Proxy bypass entries must be 255 characters or fewer');
    }
    return [...new Set(normalized)];
  }

  function parseProxyUrl(rawUrl, bypassList) {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      throw configError('Proxy URL is required', 'INVALID_PROXY_URL');
    }

    let parsed;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw configError('Proxy URL is invalid', 'INVALID_PROXY_URL');
    }

    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (!supportedSchemes.has(scheme)) {
      throw configError(`Unsupported proxy scheme: ${scheme || '(empty)'}`, 'UNSUPPORTED_PROXY_SCHEME');
    }
    if (!parsed.hostname) {
      throw configError('Proxy URL must include a hostname', 'INVALID_PROXY_URL');
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
      throw configError('Proxy URL cannot include a path, query, or fragment', 'INVALID_PROXY_URL');
    }

    const port = parsed.port ? Number(parsed.port) : defaultPorts[scheme];
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw configError('Proxy port must be between 1 and 65535', 'INVALID_PROXY_URL');
    }

    const username = decodeComponent(parsed.username, 'username');
    const password = decodeComponent(parsed.password, 'password');
    if ((username && !password) || (!username && password)) {
      throw configError('Proxy URL must include both username and password', 'INVALID_PROXY_CREDENTIALS');
    }
    if (username && (scheme === 'socks4' || scheme === 'socks5')) {
      throw configError('Chrome does not support authenticated SOCKS proxies', 'UNSUPPORTED_PROXY_AUTH');
    }

    return {
      server: {
        scheme,
        host: parsed.hostname,
        port
      },
      bypassList: normalizeBypassList(bypassList),
      credentials: username ? { username, password } : null
    };
  }

  function normalizeProxyConfig(input) {
    if (typeof input === 'string') {
      return parseProxyUrl(input);
    }
    if (!input || typeof input !== 'object') {
      throw configError('Proxy configuration is required');
    }
    if (input.url) {
      return parseProxyUrl(input.url, input.bypass ?? input.bypassList);
    }

    // Compatibility with the original __pcn.set({ host, port, scheme }) API.
    const scheme = String(input.scheme || 'http').toLowerCase();
    const host = String(input.host || '').trim();
    const port = Number(input.port ?? 8080);
    if (!supportedSchemes.has(scheme)) {
      throw configError(`Unsupported proxy scheme: ${scheme}`, 'UNSUPPORTED_PROXY_SCHEME');
    }
    if (!host || /\s/.test(host)) {
      throw configError('Proxy host is required');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw configError('Proxy port must be between 1 and 65535');
    }
    if ((input.username && !input.password) || (!input.username && input.password)) {
      throw configError('Proxy configuration must include both username and password', 'INVALID_PROXY_CREDENTIALS');
    }
    const credentials = input.username && input.password
      ? { username: String(input.username), password: String(input.password) }
      : null;
    if (credentials && (scheme === 'socks4' || scheme === 'socks5')) {
      throw configError('Chrome does not support authenticated SOCKS proxies', 'UNSUPPORTED_PROXY_AUTH');
    }
    return {
      server: { scheme, host, port },
      bypassList: normalizeBypassList(input.bypass ?? input.bypassList),
      credentials
    };
  }

  function sanitizedStatus(state) {
    if (!state || state.mode === 'direct') {
      const status = { mode: 'direct', enabled: false, authenticated: false };
      if (state && state.error) status.error = state.error;
      return status;
    }
    const { scheme, host, port } = state.config.server;
    return {
      mode: state.source === 'default' ? 'default' : 'override',
      enabled: true,
      server: `${scheme}://${host}:${port}`,
      bypassList: [...state.config.bypassList],
      authenticated: Boolean(state.config.credentials)
    };
  }

  return Object.freeze({
    normalizeBypassList,
    normalizeProxyConfig,
    parseProxyUrl,
    sanitizedStatus
  });
});
