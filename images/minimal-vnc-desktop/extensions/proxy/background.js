importScripts('runtime-config.js', 'proxy-config.js');

const STATE_KEY = 'popcornProxyState';
const trustedControlHosts = new Set(['127.0.0.1', 'localhost']);
const runtimeConfig = globalThis.POPCORN_PROXY_RUNTIME_CONFIG || {};
const controlPort = String(runtimeConfig.controlPort || '6080');
const authAttemptedRequestIds = new Set();
let activeState = null;
let pendingAuthState;
let mutationQueue = Promise.resolve();

function base64ToUtf8(value) {
  if (!value) return '';
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function chromeProxyValue(config) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: config.server,
      bypassList: config.bypassList
    }
  };
}

async function applyAndPersist(state) {
  pendingAuthState = state;
  try {
    if (state.mode === 'direct') {
      await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' });
    } else {
      await chrome.proxy.settings.set({ value: chromeProxyValue(state.config), scope: 'regular' });
    }
    activeState = state;
    authAttemptedRequestIds.clear();
    await chrome.storage.session.set({ [STATE_KEY]: state });
  } finally {
    pendingAuthState = undefined;
  }
}

function serializeMutation(operation) {
  const result = mutationQueue.catch(() => {}).then(operation);
  mutationQueue = result;
  return result;
}

async function initialize() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  if (stored[STATE_KEY]) {
    await applyAndPersist(stored[STATE_KEY]);
    return;
  }

  const url = base64ToUtf8(runtimeConfig.urlBase64);
  const bypass = base64ToUtf8(runtimeConfig.bypassBase64);
  if (!url) {
    await applyAndPersist({ mode: 'direct', source: 'startup' });
    return;
  }

  try {
    const config = PopcornProxyConfig.normalizeProxyConfig(bypass ? { url, bypass } : { url });
    await applyAndPersist({ mode: 'proxy', source: 'default', config });
  } catch (error) {
    console.error(`[popcorn-proxy] default proxy rejected: ${error.message}`);
    await applyAndPersist({
      mode: 'direct',
      source: 'startup',
      error: { code: error.code || 'INVALID_PROXY_CONFIG', message: error.message }
    });
  }
}

const initialization = initialize();

function senderIsTrusted(sender, messageType) {
  try {
    const url = new URL(sender.url);
    const expectedPath = messageType === 'PCN_PROXY_STATUS'
      ? new Set(['/proxy-control.html', '/proxy-bootstrap.html'])
      : new Set(['/proxy-control.html']);
    return sender.frameId === 0
      && url.protocol === 'http:'
      && trustedControlHosts.has(url.hostname)
      && String(url.port || '80') === controlPort
      && !url.username
      && !url.password
      && !url.search
      && expectedPath.has(url.pathname)
      && (url.pathname === '/proxy-bootstrap.html' || !url.hash);
  } catch {
    return false;
  }
}

function proxyChallengeMatches(details, state) {
  if (!details.isProxy || !state || state.mode !== 'proxy' || !state.config.credentials) return false;
  const challenger = details.challenger || {};
  return challenger.host === state.config.server.host
    && Number(challenger.port) === state.config.server.port;
}

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    initialization
      .then(() => {
        const authStates = pendingAuthState === undefined
          ? [activeState]
          : [pendingAuthState, activeState];
        const authState = authStates.find((state) => proxyChallengeMatches(details, state));
        if (!authState) {
          callback({});
          return;
        }
        if (authAttemptedRequestIds.has(details.requestId)) {
          callback({ cancel: true });
          return;
        }
        authAttemptedRequestIds.add(details.requestId);
        callback({ authCredentials: authState.config.credentials });
      })
      .catch(() => callback({}));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

function clearAuthAttempt(details) {
  authAttemptedRequestIds.delete(details.requestId);
}

chrome.webRequest.onCompleted.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!senderIsTrusted(sender, message.type)) {
    sendResponse({ success: false, code: 'UNTRUSTED_CALLER', error: 'Proxy control is available only from the local control page' });
    return false;
  }

  (async () => {
    await initialization;
    switch (message.type) {
      case 'PCN_PROXY_SET': {
        const config = PopcornProxyConfig.normalizeProxyConfig(message.config);
        await serializeMutation(() => applyAndPersist({ mode: 'proxy', source: 'override', config }));
        return {
          ...PopcornProxyConfig.sanitizedStatus(activeState),
          applied: { ...config.server }
        };
      }
      case 'PCN_PROXY_CLEAR':
        await serializeMutation(() => applyAndPersist({ mode: 'direct', source: 'override' }));
        return PopcornProxyConfig.sanitizedStatus(activeState);
      case 'PCN_PROXY_STATUS':
        await mutationQueue.catch(() => {});
        return PopcornProxyConfig.sanitizedStatus(activeState);
      case 'PCN_PROXY_GET':
        await mutationQueue.catch(() => {});
        return activeState && activeState.mode === 'proxy'
          ? {
              ...activeState.config.server,
              bypassList: [...activeState.config.bypassList]
            }
          : null;
      default:
        throw Object.assign(new Error('Unsupported proxy extension request'), { code: 'UNSUPPORTED_PROXY_REQUEST' });
    }
  })()
    .then((result) => sendResponse({ success: true, result }))
    .catch((error) => sendResponse({
      success: false,
      code: error.code || 'PROXY_EXTENSION_ERROR',
      error: error.message || 'Proxy extension request failed'
    }));

  return true;
});
