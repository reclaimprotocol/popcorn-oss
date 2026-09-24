// Local process integration: actual proxy + Chromium, synthetic portal and Agones.
// Node >= 22. No container, database, credentials, or external requests are needed.
// POPCORN_HANDOFF_TEST_CHROME=/absolute/path/to/chrome node --test scripts/viewer-handoff-test.mjs
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = tcpServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function json(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  } catch (cause) {
    throw new Error(`Local JSON request failed: ${url}`, { cause });
  }
  assert.equal(response.status, 200, `HTTP response for ${new URL(url).pathname}`);
  return response.json();
}

async function socket(url) {
  const ws = new WebSocket(url);
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket open timed out')); }, 3_000);
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
      ws.addEventListener('close', () => reject(new Error('WebSocket closed before open')), { once: true });
    });
    return ws;
  } finally { clearTimeout(timer); }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.sequence = 0;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  static async open(origin) {
    const version = await json(`${origin}/json/version`);
    return new Cdp(await socket(version.webSocketDebuggerUrl));
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 3_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    assert.equal(result.exceptionDetails, undefined, 'Synthetic portal evaluation must succeed');
    return result.result.value;
  }
}

for (const emulationOwner of ['runtime', 'restricted-cdp']) {
test(`viewer handoff preserves the authenticated tab and ${emulationOwner} overrides`, { timeout: 90_000 }, async t => {
  const chrome = process.env.POPCORN_HANDOFF_TEST_CHROME;
  assert.ok(chrome, 'Set POPCORN_HANDOFF_TEST_CHROME to a local Chromium executable. This test does not silently skip.');
  assert.ok(globalThis.WebSocket, 'This test requires Node 22 or later.');
  await access(chrome, constants.X_OK);
  assert.ok((await stat(chrome)).isFile(), 'The Chromium executable must be a file.');
  const directory = await mkdtemp(join(tmpdir(), 'popcorn-handoff-browser-'));
  const children = new Set();
  const websockets = new Set();
  const servers = new Set();
  const tcpConnections = new Set();
  const source = resolve(fileURLToPath(new URL('../proxy', import.meta.url)));
  const proxyBinary = join(directory, 'novnc-proxy');
  const logs = new Map();

  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    try { await exited; } finally { clearTimeout(timer); children.delete(child); }
  };
  const start = (command, args, env) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    logs.set(child, '');
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', data => logs.set(child, (logs.get(child) + data.toString()).slice(-16_384)));
    }
    return child;
  };
  const keepSocket = ws => { websockets.add(ws); return ws; };
  const serve = server => { servers.add(server); return listen(server); };

  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        t.diagnostic(`Local fixture process exited with code ${child.exitCode}: ${logs.get(child)}`);
      }
    }
    for (const ws of websockets) ws.close();
    for (const child of children) await stop(child);
    for (const connection of tcpConnections) connection.destroy();
    for (const server of servers) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });

  await exec('go', ['build', '-o', proxyBinary, '.'], {
    cwd: source, timeout: 30_000,
    env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
  });

  const podUid = 'synthetic-pod-uid';
  const sessionId = 'synthetic-handoff-session';
  const annotations = {};
  let sdkAvailable = true;
  const sdkPort = await serve(httpServer(async (request, response) => {
    if (!sdkAvailable) { response.writeHead(503).end(); return; }
    if (request.method === 'GET' && request.url === '/gameserver') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ object_meta: { uid: 'synthetic-gameserver-uid', annotations: { ...annotations } } }));
    } else if (request.method === 'PUT' && request.url === '/metadata/annotation') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { key, value } = JSON.parse(body);
      annotations[`agones.dev/sdk-${key}`] = value;
      response.writeHead(200).end();
    } else response.writeHead(404).end();
  }));
  let rfbBytes = 0;
  const rfbPort = await serve(tcpServer(connection => {
    tcpConnections.add(connection);
    connection.on('close', () => tcpConnections.delete(connection));
    connection.on('data', bytes => { rfbBytes += bytes.length; connection.write(bytes); });
  }));
  const portalPort = await serve(httpServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(303, { 'Set-Cookie': 'synthetic_auth=present; HttpOnly; SameSite=Strict; Path=/', Location: '/account' }).end();
      return;
    }
    if (!request.headers.cookie?.includes('synthetic_auth=present')) { response.writeHead(401).end(); return; }
    if (request.url === '/authenticated-check') { response.writeHead(200).end('authenticated'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authenticated fixture</title><button style="position:absolute;left:0;top:0;width:200px;height:100px" onclick="window.fixtureClicks++">Fixture</button><script>window.fixtureClicks=0;window.fixtureMemory="preserved";sessionStorage.setItem("fixture","preserved")</script>');
  }));

  const profile = join(directory, 'chrome-profile');
  await mkdir(profile);
  start(chrome, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], process.env);
  const chromePort = await until(async () => {
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return false; }
  }, 'local Chromium startup');
  const [viewerPort, restrictedPort, trustedPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const viewerOrigin = `http://127.0.0.1:${viewerPort}`;
  const trustedOrigin = `http://127.0.0.1:${trustedPort}`;
  const restrictedOrigin = `http://127.0.0.1:${restrictedPort}`;
  const runtimeEnv = {
    ...process.env, KUBERNETES_SERVICE_HOST: '127.0.0.1', POD_NAME: 'synthetic-browser', POD_UID: podUid,
    AGONES_SDK_HOST: '127.0.0.1', AGONES_SDK_HTTP_PORT: String(sdkPort),
    LIVEVIEW_E2E_SESSION_ID: '', LIVEVIEW_E2E_CLIENT_PUBLIC_KEY: '', LIVEVIEW_E2E_BINDING_SECRET_HASH: '', LIVEVIEW_E2E_BINDING_FILE: '',
  };
  const startRuntime = async () => {
    const child = start(proxyBinary, ['--listen', `127.0.0.1:${viewerPort}`, '--vnc', `127.0.0.1:${rfbPort}`, '--web', directory, '--ready-file', '',
      '--cdp-upstream', `127.0.0.1:${chromePort}`, '--cdp-restricted-listen', `127.0.0.1:${restrictedPort}`, '--cdp-full-listen', `127.0.0.1:${trustedPort}`], runtimeEnv);
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Proxy exited: ${logs.get(child)}`);
      try { return await json(`${viewerOrigin}/_popcorn/viewer-handoff-status`); } catch { return false; }
    }, 'local runtime startup');
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Proxy exited: ${logs.get(child)}`);
      try {
        const responses = await Promise.all([restrictedOrigin, trustedOrigin].map(origin =>
          fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1_000) })));
        return [200, 403].includes(responses[0].status) && responses[1].status === 200;
      } catch { return false; }
    }, 'local restricted and trusted CDP listeners');
    return child;
  };
  const status = async () => {
    const response = await fetch(`${viewerOrigin}/_popcorn/viewer-handoff-status`, { signal: AbortSignal.timeout(1_000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['podUid', 'runtimeInstanceId', 'sessionId', 'state', 'version']);
    return result;
  };
  const waitState = state => until(async () => { const result = await status(); return result.state === state && result; }, `runtime state ${state}`);
  const denied = async origin => {
    const response = await fetch(origin, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 403, `Viewer access must be denied: ${new URL(origin).pathname}`);
  };

  let runtime = await startRuntime();
  assert.equal((await status()).state, 'awaiting_binding');
  await denied(`${viewerOrigin}/websockify`);
  await denied(`${restrictedOrigin}/json/version`);
  annotations['popcorn.dev/session-id'] = sessionId;
  annotations['popcorn.dev/session-bound-at'] = '2026-09-24T12:00:00.000Z';
  const active = await waitState('active');
  assert.equal(active.sessionId, sessionId);
  assert.equal(active.podUid, podUid);
  assert.equal(active.version, 1);
  const statusWrite = await fetch(`${viewerOrigin}/_popcorn/viewer-handoff-status`, {
    method: 'POST', body: JSON.stringify({ expectedPodUid: podUid }), signal: AbortSignal.timeout(2_000),
  });
  assert.equal(statusWrite.status, 405, 'The runtime status endpoint cannot request handoff');
  assert.equal((await status()).state, 'active');
  assert.equal(annotations['popcorn.dev/viewer-handoff'], undefined);

  const trusted = await Cdp.open(trustedOrigin);
  keepSocket(trusted.ws);
  const target = (await trusted.send('Target.getTargets')).targetInfos.find(target => target.type === 'page');
  assert.ok(target, 'Chromium has a retained tab');
  const attachment = await trusted.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await trusted.send('Page.navigate', { url: `http://127.0.0.1:${portalPort}/login` }, attachment.sessionId);
  await until(async () => {
    try { return await trusted.evaluate(attachment.sessionId, 'document.title === "Authenticated fixture" && document.readyState === "complete"'); }
    catch { return false; }
  }, 'synthetic authenticated portal');

  const restricted = await Cdp.open(restrictedOrigin);
  keepSocket(restricted.ws);
  const viewerSockets = [
    await socket(`${viewerOrigin.replace('http', 'ws')}/websockify`),
    await socket(`${viewerOrigin.replace('http', 'ws')}/kbd`),
    await socket(`${viewerOrigin.replace('http', 'ws')}/input`),
    restricted.ws,
  ];
  viewerSockets.forEach(keepSocket);
  viewerSockets[0].send(Uint8Array.from([4, 1, 0, 0, 0, 0, 0, 65]));
  await until(() => rfbBytes === 8, 'ordinary RFB forwarding');
  assert.equal((await fetch(`${viewerOrigin}/kbdstate`)).status, 200);
  await trusted.send('Target.activateTarget', { targetId: target.targetId });
  await trusted.send('Page.bringToFront', {}, attachment.sessionId);
  viewerSockets[2].send(JSON.stringify({ t: 'click', points: [{ x: 20, y: 20 }], d: 'fixture', g: 1 }));
  await until(async () => (await trusted.evaluate(attachment.sessionId, 'window.fixtureClicks')) === 1,
    'ordinary viewer input reaches the actual authenticated tab');
  const viewportExpression = '({width:innerWidth,height:innerHeight,scale:devicePixelRatio,touch:navigator.maxTouchPoints})';
  const expectedViewport = { width: 412, height: 732, scale: 2, touch: 5 };
  const emulated = await fetch(`${viewerOrigin}/emulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 412, height: 732, deviceScaleFactor: 2, mobile: true, touch: true }),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(emulated.status, 200);
  await until(async () => JSON.stringify(await trusted.evaluate(attachment.sessionId, viewportExpression)) === JSON.stringify(expectedViewport),
    'viewer mobile viewport and touch overrides reach Chromium');

  if (emulationOwner === 'restricted-cdp') {
    const viewerAttachment = await restricted.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await restricted.send('Emulation.setDeviceMetricsOverride', {
      width: 412, height: 732, deviceScaleFactor: 3, mobile: true,
    }, viewerAttachment.sessionId);
    await restricted.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 }, viewerAttachment.sessionId);
    expectedViewport.scale = 3;
    expectedViewport.touch = 2;
    await until(async () => JSON.stringify(await trusted.evaluate(attachment.sessionId, viewportExpression)) === JSON.stringify(expectedViewport),
      'restricted CDP-owned overrides reach Chromium');
  }

  annotations['popcorn.dev/viewer-handoff'] = podUid;
  const revoked = await waitState('revoked');
  assert.equal(revoked.runtimeInstanceId, active.runtimeInstanceId);
  await until(() => viewerSockets.every(ws => ws.readyState === WebSocket.CLOSED), 'existing viewer and restricted CDP connection closure');
  for (const path of ['/websockify', '/vnc-ws/session', '/liveview-ws/session', '/kbd', '/kbdstate', '/input', '/dialog', '/emulate', '/e2e/rfb', '/e2e/control']) {
    await denied(`${viewerOrigin}${path}`);
  }
  for (const path of ['/emulate', '/geometry', '/dialog']) {
    const response = await fetch(`${viewerOrigin}${path}`, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 403, `Viewer mutation must be denied: ${path}`);
  }
  await denied(`${restrictedOrigin}/json/version`);
  await assert.rejects(socket(`${viewerOrigin.replace('http', 'ws')}/websockify`));
  await assert.rejects(socket(`${viewerOrigin.replace('http', 'ws')}/input`));

  const assertAuthenticated = async cdp => {
    const targets = (await cdp.send('Target.getTargets')).targetInfos.filter(item => item.type === 'page');
    assert.equal(targets.length, 1, 'Handoff does not create or close a browser tab');
    assert.equal(targets[0].targetId, target.targetId, 'Handoff preserves the original target');
    const { sessionId: attached } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    assert.deepEqual(await cdp.evaluate(attached, '({memory:window.fixtureMemory,storage:sessionStorage.getItem("fixture"),clicks:window.fixtureClicks})'),
      { memory: 'preserved', storage: 'preserved', clicks: 1 });
    assert.equal(await cdp.evaluate(attached, 'fetch("/authenticated-check").then(response=>response.status)'), 200, 'The authenticated cookie stays in the same browser');
  };
  await assertAuthenticated(trusted);
  assert.deepEqual(await trusted.evaluate(attachment.sessionId, viewportExpression), expectedViewport,
    'Handoff must not involuntarily reset the viewport, device scale, or touch capability');
  const reconnect = await Cdp.open(trustedOrigin);
  keepSocket(reconnect.ws);
  await assertAuthenticated(reconnect);
  assert.equal(rfbBytes, 8, 'No more RFB input reaches the upstream after closure');

  await stop(runtime);
  runtime = await startRuntime();
  const restarted = await waitState('revoked');
  assert.notEqual(restarted.runtimeInstanceId, revoked.runtimeInstanceId);
  assert.equal(restarted.sessionId, sessionId);
  await denied(`${viewerOrigin}/websockify`);
  await denied(`${restrictedOrigin}/json/version`);
  const afterRestart = await Cdp.open(trustedOrigin);
  keepSocket(afterRestart.ws);
  await assertAuthenticated(afterRestart);

  await stop(runtime);
  sdkAvailable = false;
  await startRuntime();
  assert.notEqual((await status()).state, 'active', 'An unavailable allocation store cannot restore viewer access');
  await denied(`${viewerOrigin}/websockify`);
  await denied(`${restrictedOrigin}/json/version`);
  t.diagnostic('Actual Chromium and proxy process passed. Agones, portal authentication, and RFB upstream were synthetic; no Xvnc or browser extension ran.');
});
}
