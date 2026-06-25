// Popcorn Proxy Extension - Injected Script
// Exposes stealth API for page-level proxy configuration

(function() {
  'use strict';

  const pendingRequests = new Map();
  let requestCounter = 0;

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
        pending.reject(new Error(message.error || 'Unknown error'));
      }
    }
  });

  function sendToExtension(type, config) {
    return new Promise((resolve, reject) => {
      const requestId = ++requestCounter;
      pendingRequests.set(requestId, { resolve, reject });

      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 10000);

      window.postMessage({
        type: type,
        direction: 'to-extension',
        requestId: requestId,
        config: config
      }, '*');
    });
  }

  // Use non-obvious property name to avoid detection
  // Looks like an internal performance/config variable
  Object.defineProperty(window, '__pcn', {
    value: Object.freeze({
      set: function(config) {
        return sendToExtension('PCN_PROXY_SET', config);
      },
      clear: function() {
        return sendToExtension('PCN_PROXY_CLEAR', null);
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
})();
