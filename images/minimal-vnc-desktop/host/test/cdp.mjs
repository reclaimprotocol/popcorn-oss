// cdp.mjs — the smallest CDP client that can drive a real browser.
//
// Zero dependencies, like every other test harness in this repo: Node 22+ has a
// global WebSocket, and Chrome's DevTools endpoint is a JSON-over-WebSocket
// protocol, so a client is about sixty lines. Deliberately not puppeteer — this
// runs in the same "no build step, no node_modules" world as kbd/test.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Where Chrome lives, per platform, plus an override for CI images.
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function chromePath() {
  for (const p of CANDIDATES) { try { if (existsSync(p)) return p; } catch (_) {} }
  return null;
}

export function launch({ port, profile, headless = true }) {
  const bin = chromePath();
  if (!bin) return null;
  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=420,900',
  ];
  if (headless) args.push('--headless=new');
  args.push('about:blank');
  const p = spawn(bin, args, { stdio: 'ignore', detached: true });
  p.unref();
  return p;
}

export async function browserWs(port, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('chrome did not expose a CDP endpoint on :' + port);
}

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('CDP socket error')));
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    });
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
