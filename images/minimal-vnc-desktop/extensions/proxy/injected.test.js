const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadInjectedApi() {
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
    postMessage(message) {
      if (message.direction !== 'to-extension') return;
      const setConfig = message.config || {};
      const applied = {
        scheme: setConfig.scheme || 'http',
        host: setConfig.host || 'proxy.example',
        port: setConfig.port ?? 8080
      };
      const results = {
        PCN_PROXY_SET: {
          mode: 'override',
          enabled: true,
          server: `${applied.scheme}://${applied.host}:${applied.port}`,
          authenticated: false,
          applied
        },
        PCN_PROXY_GET: {
          scheme: 'http',
          host: 'proxy.example',
          port: 8080,
          bypassList: ['localhost', '127.0.0.1']
        },
        PCN_PROXY_CLEAR: { mode: 'direct', enabled: false, authenticated: false },
        PCN_PROXY_STATUS: { mode: 'direct', enabled: false, authenticated: false }
      };
      queueMicrotask(() => window.dispatchEvent({
        type: 'message',
        source: window,
        data: {
          type: 'PCN_PROXY_RESPONSE',
          direction: 'to-page',
          requestId: message.requestId,
          success: true,
          result: results[message.type]
        }
      }));
    }
  };

  const context = vm.createContext({
    window,
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type;
      }
    },
    Error,
    Number,
    Object,
    Promise,
    URL,
    clearTimeout,
    queueMicrotask,
    setTimeout
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'injected.js'), 'utf8'),
    context,
    { filename: 'injected.js' }
  );
  return window;
}

test('exposes the public connect/set/status/clear interface', async () => {
  const window = loadInjectedApi();
  const proxy = await window.PopcornProxy.connect();

  assert.equal(typeof proxy.set, 'function');
  assert.equal(typeof proxy.status, 'function');
  assert.equal(typeof proxy.clear, 'function');
  assert.equal((await proxy.set('http://proxy.example:8080')).mode, 'override');
  assert.equal((await proxy.status()).mode, 'direct');
  assert.equal((await proxy.clear()).mode, 'direct');
});

test('preserves the original __pcn set and clear response contracts', async () => {
  const window = loadInjectedApi();

  assert.deepEqual(
    JSON.parse(JSON.stringify(await window.__pcn.set({
      scheme: 'http',
      host: 'proxy.example'
    }))),
    { configured: true, host: 'proxy.example', port: 8080, scheme: 'http' }
  );
  for (const [scheme, port] of [['http', 80], ['https', 443]]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(await window.__pcn.set({ host: 'proxy.example', scheme, port }))),
      { configured: true, host: 'proxy.example', port, scheme }
    );
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(await window.__pcn.clear())),
    { cleared: true }
  );
});
