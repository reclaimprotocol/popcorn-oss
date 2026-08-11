// Popcorn Proxy Extension - Content Script
// Bridges between page context and extension background

(function() {
  'use strict';

  if (window.top !== window || !['/proxy-control.html', '/proxy-bootstrap.html'].includes(location.pathname)) {
    return;
  }

  const allowedMessageTypes = new Set([
    'PCN_PROXY_SET',
    'PCN_PROXY_CLEAR',
    'PCN_PROXY_GET',
    'PCN_PROXY_STATUS'
  ]);

  // Inject the page-level script
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  // Listen for messages from the injected script
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || !allowedMessageTypes.has(message.type)) return;
    if (message.direction !== 'to-extension') return;

    const requestId = message.requestId;

    try {
      const response = await chrome.runtime.sendMessage({
        type: message.type,
        config: message.config
      });

      if (!response) {
        throw new Error('Proxy extension background did not respond');
      }

      window.postMessage({
        type: 'PCN_PROXY_RESPONSE',
        direction: 'to-page',
        requestId: requestId,
        success: response.success,
        result: response.result !== undefined ? response.result : response.config,
        code: response.code,
        error: response.error
      }, '*');
    } catch (error) {
      window.postMessage({
        type: 'PCN_PROXY_RESPONSE',
        direction: 'to-page',
        requestId: requestId,
        success: false,
        code: error.code || 'PROXY_EXTENSION_ERROR',
        error: error.message
      }, '*');
    }
  });
})();
