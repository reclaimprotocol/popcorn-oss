// Local-only integration check using a temporary page.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { cdp: { type: 'string' } } });
if (!values.cdp) throw new Error('Pass --cdp http://127.0.0.1:PORT');
const base = new URL(values.cdp);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password) throw new Error('Use a loopback CDP endpoint');

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('CDP connection timeout')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP connection failed')); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data));
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    clearTimeout(request.timeout);
    if (value.error) request.reject(new Error(request.method + ': ' + value.error.message));
    else request.resolve(value.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('CDP disconnected'));
    }
    pending.clear();
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timeout = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timeout')); }, 15000);
        pending.set(key, { resolve, reject, timeout, method });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

const version = await fetch(base.origin + '/json/version', { signal: AbortSignal.timeout(5000) }).then(r => r.json());
const browser = await connect(version.webSocketDebuggerUrl);
let targetId;
let page;
const results = { browser: version.Browser, phases: [] };
try {
  ({ targetId } = await browser.send('Target.createTarget', {
    url: 'data:text/html,<title>Native input capability check</title><body></body>', background: true,
  }));
  const targets = await fetch(base.origin + '/json/list', { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  page = await connect(targets.find(t => t.id === targetId).webSocketDebuggerUrl);

  async function measure(label) {
    const result = await page.send('Runtime.evaluate', {
      expression: `(async () => {
        if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        const read = w => ({ fine: w.matchMedia('(pointer:fine)').matches,
          coarse: w.matchMedia('(pointer:coarse)').matches, none: w.matchMedia('(pointer:none)').matches,
          hover: w.matchMedia('(hover:hover)').matches, anyHover: w.matchMedia('(any-hover:hover)').matches,
          touchPoints: w.navigator.maxTouchPoints });
        const frame = document.createElement('iframe');
        await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = '<body></body>'; document.body.appendChild(frame); });
        const value = { main: read(window), iframe: read(frame.contentWindow) };
        frame.remove(); return value;
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('Local capability probe failed');
    results.phases.push({ label, ...result.result.value });
    return result.result.value;
  }
  function desktop(value) {
    for (const realm of [value.main, value.iframe]) {
      assert.equal(realm.fine, true, 'desktop fine pointer missing');
      assert.equal(realm.hover, true, 'desktop hover missing');
      assert.equal(realm.anyHover, true, 'desktop any-hover missing');
      assert.equal(realm.coarse, false);
      assert.equal(realm.none, false);
      assert.equal(realm.touchPoints, 0);
    }
  }
  desktop(await measure('desktop'));
  try {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const touch = await measure('touch-emulated');
    for (const realm of [touch.main, touch.iframe]) {
      assert.equal(realm.coarse, true);
      assert.equal(realm.hover, false);
      assert.equal(realm.touchPoints, 5);
    }
  } finally {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  desktop(await measure('desktop-restored'));
  console.log(JSON.stringify({ passed: true, ...results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: error.message, ...results }, null, 2));
  process.exitCode = 1;
} finally {
  if (targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  page?.close();
  browser.close();
}
