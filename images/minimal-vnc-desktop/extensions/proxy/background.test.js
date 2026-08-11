const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extensionDir = __dirname;
const plain = (value) => JSON.parse(JSON.stringify(value));

function createExtension(defaultProxyUrl = '', defaultBypass = 'localhost,*.svc') {
  const sessionState = {};
  const appliedProxyValues = [];
  let authListener;
  let completedListener;
  let errorListener;
  let messageListener;
  let rejectNextFixedProxy = false;
  let deferNextFixedProxy = false;
  let fixedProxyAttemptResolve;
  let fixedProxyRelease;
  let fixedProxyAttempt = Promise.resolve();

  const context = vm.createContext({
    URL,
    TextDecoder,
    Uint8Array,
    atob,
    console,
    setTimeout,
    clearTimeout,
    POPCORN_PROXY_RUNTIME_CONFIG: {
      urlBase64: Buffer.from(defaultProxyUrl).toString('base64'),
      bypassBase64: Buffer.from(defaultBypass).toString('base64'),
      controlPort: '6080'
    },
    chrome: {
      storage: {
        session: {
          async get(key) {
            return key in sessionState ? { [key]: sessionState[key] } : {};
          },
          async set(values) {
            Object.assign(sessionState, values);
          }
        }
      },
      proxy: {
        settings: {
          async set(options) {
            if (rejectNextFixedProxy && options.value.mode === 'fixed_servers') {
              rejectNextFixedProxy = false;
              throw new Error('Chrome rejected proxy settings');
            }
            if (deferNextFixedProxy && options.value.mode === 'fixed_servers') {
              deferNextFixedProxy = false;
              fixedProxyAttemptResolve();
              await new Promise((resolve) => {
                fixedProxyRelease = resolve;
              });
            }
            appliedProxyValues.push(options.value);
          }
        }
      },
      webRequest: {
        onAuthRequired: {
          addListener(listener) {
            authListener = listener;
          }
        },
        onCompleted: {
          addListener(listener) {
            completedListener = listener;
          }
        },
        onErrorOccurred: {
          addListener(listener) {
            errorListener = listener;
          }
        }
      },
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          }
        }
      }
    }
  });

  context.globalThis = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      if (file === 'runtime-config.js') continue;
      vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8'), context, {
    filename: 'background.js'
  });

  async function send(
    type,
    config = null,
    senderUrl = 'http://127.0.0.1:6080/proxy-control.html',
    frameId = 0
  ) {
    return new Promise((resolve) => {
      messageListener(
        { type, config },
        { url: senderUrl, frameId },
        resolve
      );
    });
  }

  async function authenticate(details) {
    return new Promise((resolve) => authListener(details, resolve));
  }

  return {
    appliedProxyValues,
    authenticate,
    complete(requestId) {
      completedListener({ requestId });
    },
    fail(requestId) {
      errorListener({ requestId });
    },
    rejectNextFixedProxy() {
      rejectNextFixedProxy = true;
    },
    deferNextFixedProxy() {
      deferNextFixedProxy = true;
      fixedProxyAttempt = new Promise((resolve) => {
        fixedProxyAttemptResolve = resolve;
      });
    },
    releaseFixedProxy() {
      fixedProxyRelease();
    },
    waitForFixedProxyAttempt() {
      return fixedProxyAttempt;
    },
    send
  };
}

test('applies the container default and authenticates only matching proxy challenges', async () => {
  const extension = createExtension('http://proxy-user:p%40ss@proxy.example:8080');
  const status = await extension.send('PCN_PROXY_STATUS');

  assert.deepEqual(plain(status.result), {
    mode: 'default',
    enabled: true,
    server: 'http://proxy.example:8080',
    bypassList: ['localhost', '*.svc'],
    authenticated: true
  });
  assert.equal(extension.appliedProxyValues.at(-1).rules.singleProxy.host, 'proxy.example');

  assert.deepEqual(plain(await extension.authenticate({
    isProxy: true,
    requestId: 'request-1',
    challenger: { host: 'proxy.example', port: 8080 }
  })), { authCredentials: { username: 'proxy-user', password: 'p@ss' } });
  assert.deepEqual(plain(await extension.authenticate({
    isProxy: false,
    requestId: 'request-2',
    challenger: { host: 'proxy.example', port: 8080 }
  })), {});
});

test('cancels a repeated authentication challenge instead of looping credentials', async () => {
  const extension = createExtension('http://proxy-user:pass@proxy.example:8080');
  await extension.send('PCN_PROXY_STATUS');
  const challenge = {
    isProxy: true,
    requestId: 'repeated-request',
    challenger: { host: 'proxy.example', port: 8080 }
  };

  assert.deepEqual(plain(await extension.authenticate(challenge)), {
    authCredentials: { username: 'proxy-user', password: 'pass' }
  });
  assert.deepEqual(plain(await extension.authenticate(challenge)), { cancel: true });

  extension.complete('repeated-request');
  assert.deepEqual(plain(await extension.authenticate(challenge)), {
    authCredentials: { username: 'proxy-user', password: 'pass' }
  });
});

test('authenticates both old and new proxy requests during a live switch', async () => {
  const extension = createExtension('http://old-user:old-pass@old-proxy.example:8080');
  await extension.send('PCN_PROXY_STATUS');
  extension.deferNextFixedProxy();

  const setPromise = extension.send('PCN_PROXY_SET', {
    url: 'http://new-user:new-pass@new-proxy.example:8081'
  });
  await extension.waitForFixedProxyAttempt();

  assert.deepEqual(plain(await extension.authenticate({
    isProxy: true,
    requestId: 'old-request',
    challenger: { host: 'old-proxy.example', port: 8080 }
  })), { authCredentials: { username: 'old-user', password: 'old-pass' } });
  assert.deepEqual(plain(await extension.authenticate({
    isProxy: true,
    requestId: 'new-request',
    challenger: { host: 'new-proxy.example', port: 8081 }
  })), { authCredentials: { username: 'new-user', password: 'new-pass' } });

  extension.releaseFixedProxy();
  assert.equal((await setPromise).success, true);
});

test('runtime clear selects direct egress until the browser restarts', async () => {
  const extension = createExtension('http://proxy.example:8080');
  const cleared = await extension.send('PCN_PROXY_CLEAR');

  assert.deepEqual(plain(cleared.result), {
    mode: 'direct',
    enabled: false,
    authenticated: false
  });
  assert.deepEqual(plain(extension.appliedProxyValues.at(-1)), { mode: 'direct' });
});

test('uses the safe bypass defaults when no container bypass value is provided', async () => {
  const extension = createExtension('http://proxy.example:8080', '');
  const status = await extension.send('PCN_PROXY_STATUS');

  assert.deepEqual(plain(status.result.bypassList), ['localhost', '127.0.0.1']);
});

test('rejects proxy changes from non-local pages', async () => {
  const extension = createExtension();
  const response = await extension.send(
    'PCN_PROXY_SET',
    { url: 'http://attacker-proxy.example:8080' },
    'https://attacker.example/'
  );

  assert.deepEqual(plain(response), {
    success: false,
    code: 'UNTRUSTED_CALLER',
    error: 'Proxy control is available only from the local control page'
  });
});

test('authorizes only the exact top-level local control surface', async () => {
  const extension = createExtension();
  const rejectedCallers = [
    ['http://localhost:3000/proxy-control.html', 0],
    ['http://127.0.0.1:6080/liveview.html', 0],
    ['http://127.0.0.1:6080/proxy-control.html?next=bad', 0],
    ['http://user@127.0.0.1:6080/proxy-control.html', 0],
    ['http://127.0.0.1:6080/proxy-control.html', 2]
  ];

  for (const [url, frameId] of rejectedCallers) {
    const response = await extension.send('PCN_PROXY_STATUS', null, url, frameId);
    assert.equal(response.code, 'UNTRUSTED_CALLER', url);
  }

  const bootstrapStatus = await extension.send(
    'PCN_PROXY_STATUS',
    null,
    'http://localhost:6080/proxy-bootstrap.html#target',
    0
  );
  assert.equal(bootstrapStatus.success, true);
  const bootstrapMutation = await extension.send(
    'PCN_PROXY_CLEAR',
    null,
    'http://localhost:6080/proxy-bootstrap.html#target',
    0
  );
  assert.equal(bootstrapMutation.code, 'UNTRUSTED_CALLER');
});

test('does not persist or report a proxy setting that Chrome rejected', async () => {
  const extension = createExtension();
  await extension.send('PCN_PROXY_STATUS');
  extension.rejectNextFixedProxy();

  const failed = await extension.send('PCN_PROXY_SET', { url: 'http://rejected.example:8080' });
  assert.equal(failed.success, false);
  const status = await extension.send('PCN_PROXY_STATUS');
  assert.deepEqual(plain(status.result), {
    mode: 'direct',
    enabled: false,
    authenticated: false
  });
});
