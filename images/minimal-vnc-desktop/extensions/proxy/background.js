// Popcorn Proxy Extension - Background Service Worker (MV3)
// Sets proxy only - auth handled via CDP Fetch

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PCN_PROXY_SET') {
    handleSetProxy(message.config)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'PCN_PROXY_CLEAR') {
    handleClearProxy()
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'PCN_PROXY_GET') {
    chrome.storage.local.get(['proxyConfig'], (result) => {
      sendResponse({ success: true, config: result.proxyConfig || null });
    });
    return true;
  }
});

async function handleSetProxy(config) {
  if (!config || !config.host) {
    throw new Error('Proxy host is required');
  }

  const { host, port = 8080, scheme = 'http', bypassList = ['localhost', '127.0.0.1'] } = config;

  await chrome.proxy.settings.set({
    value: {
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme, host, port },
        bypassList
      }
    },
    scope: 'regular'
  });

  const proxyConfig = { host, port, scheme, bypassList };
  await chrome.storage.local.set({ proxyConfig });

  return { configured: true, host, port, scheme };
}

async function handleClearProxy() {
  await chrome.proxy.settings.set({
    value: { mode: 'direct' },
    scope: 'regular'
  });
  await chrome.storage.local.remove(['proxyConfig']);
  return { cleared: true };
}

// Restore on startup
chrome.storage.local.get(['proxyConfig'], (result) => {
  if (result.proxyConfig) {
    const { scheme, host, port, bypassList } = result.proxyConfig;
    chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme, host, port },
          bypassList: bypassList || ['localhost', '127.0.0.1']
        }
      },
      scope: 'regular'
    });
  }
});
