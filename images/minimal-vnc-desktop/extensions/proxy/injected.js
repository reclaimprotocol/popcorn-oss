// Popcorn Proxy Extension - Injected Script
// Exposes stealth API for page-level proxy configuration

(function() {
  'use strict';

  const pendingRequests = new Map();
  let requestCounter = 0;
  const DEFAULT_TIMEOUT_MS = 10000;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || message.type !== 'PCN_PROXY_RESPONSE') return;
    if (message.direction !== 'to-page') return;

    const pending = pendingRequests.get(message.requestId);
    if (pending) {
      pendingRequests.delete(message.requestId);
      if (message.success) {
        pending.resolve(message.result);
      } else {
        pending.reject(extensionError(message.error, message.code));
      }
    }
  });

  function extensionError(message, code) {
    const error = new Error(message || 'Unknown proxy extension error');
    error.code = code || 'PROXY_EXTENSION_ERROR';
    return error;
  }

  function sendToExtension(type, config, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const requestId = ++requestCounter;
      const timeout = setTimeout(() => {
        if (pendingRequests.delete(requestId)) {
          reject(extensionError('Proxy extension request timed out', 'EXTENSION_UNAVAILABLE'));
        }
      }, timeoutMs);

      pendingRequests.set(requestId, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      window.postMessage({
        type: type,
        direction: 'to-extension',
        requestId: requestId,
        config: config
      }, '*');
    });
  }

  const controller = Object.freeze({
    set(config) {
      const normalized = typeof config === 'string' ? { url: config } : config;
      return sendToExtension('PCN_PROXY_SET', normalized);
    },
    status() {
      return sendToExtension('PCN_PROXY_STATUS', null);
    },
    clear() {
      return sendToExtension('PCN_PROXY_CLEAR', null);
    }
  });

  const publicApi = Object.freeze({
    async connect(options = {}) {
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
      await sendToExtension('PCN_PROXY_STATUS', null, timeoutMs);
      return controller;
    }
  });

  Object.defineProperty(window, 'PopcornProxy', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: false
  });

  // Use non-obvious property name to avoid detection
  // Looks like an internal performance/config variable
  Object.defineProperty(window, '__pcn', {
    value: Object.freeze({
      set: function(config) {
        return sendToExtension('PCN_PROXY_SET', config)
          .then((status) => {
            return {
              configured: true,
              host: status.applied.host,
              port: status.applied.port,
              scheme: status.applied.scheme
            };
          });
      },
      clear: function() {
        return sendToExtension('PCN_PROXY_CLEAR', null).then(() => ({ cleared: true }));
      },
      get: function() {
        return sendToExtension('PCN_PROXY_GET', null);
      },
      ready: true
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });

  window.dispatchEvent(new CustomEvent('__pcnReady'));
  window.dispatchEvent(new CustomEvent('PopcornProxyReady'));
})();
