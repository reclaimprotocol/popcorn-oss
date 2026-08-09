// Shared helpers for stealth probes.
//
// Each probe imports `connect()` to attach to the running container's
// chromium over CDP, plus `humanize()` to inject realistic mouse/scroll
// behavior. Akamai/Cloudflare both score the absence of behavioral signals
// as bot-like, so any probe that hits a sensored site must call humanize()
// after navigation.
//
// minimal-vnc-desktop note: unlike chromium-headful, this image ships no
// node/playwright, so the suite runs from the HOST and connects to the
// *full* CDP proxy (default 9226). Publish it: `docker run ... -p 9226:9226`.
// The restricted proxy (9222) filters out Runtime/Page/Fetch commands the
// probes need, so it will NOT work — use 9226. To run from inside the
// container instead (after installing node), set CDP_URL=http://127.0.0.1:9223.

import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9226';
const CREDS_PATH = process.env.PROXY_CREDS || '/tmp/proxy-creds.json';
// Full proxy URL with embedded creds, e.g. BrightData:
//   HTTPS_PROXY_URL='https://brd-customer-...-country-{{geoLocation}}:PASS@brd.superproxy.io:33335/'
// {{geoLocation}} is replaced with PROXY_GEO (default 'us'). This is a
// credential — pass it via env, never commit it.
const PROXY_URL = process.env.HTTPS_PROXY_URL || '';
const PROXY_GEO = process.env.PROXY_GEO || 'us';
// Sticky BrightData session: appended to the auth username as `-session-<id>`
// so the exit IP stays constant instead of rotating every request (rotation
// tanks reCAPTCHA v3 and prevents any IP reputation from building). Set
// PROXY_SESSION to a fixed value to reuse the SAME exit IP across runs (needed
// for profile/cookie warming); leave unset for a fresh sticky IP per run.
// Alphanumeric only: BrightData usernames are dash-delimited, so a dash/underscore
// in the session id breaks auth (407 client_10001).
const PROXY_SESSION = (process.env.PROXY_SESSION || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`).replace(/[^a-zA-Z0-9]/g, '');
// Optional override for the chrome.proxy scheme (the hop TO the proxy).
// Empty → use the scheme from HTTPS_PROXY_URL. BrightData's superproxy on
// 33335 accepts both plain-HTTP CONNECT and TLS, so `https` works; if loads
// hang/blank through the proxy, try PROXY_SCHEME=http. NOTE: the proxy only
// works with the CDP auth handler installed (a 407 with no handler shows a
// blank page) — that's what connect() does when creds are present.
const PROXY_SCHEME = process.env.PROXY_SCHEME || '';
// Proxy-bypassed local page used to bootstrap the __pcn content script (it
// only injects on http(s) pages, never about:blank). localhost is in the
// extension's default bypassList, so it loads even if a bad proxy is set.
const NOVNC_BASE_URL = process.env.NOVNC_BASE_URL || `http://127.0.0.1:${process.env.NOVNC_PORT || 6080}`;
const BOOTSTRAP_URL = `${NOVNC_BASE_URL}/liveview.html`;
const RESET_VIEWPORT = process.env.STEALTH_RESET_VIEWPORT !== '0';

// Parse a proxy URL into parts, substituting the {{geoLocation}} template.
export function parseProxyUrl(raw, geo) {
  const url = raw.replace(/\{\{geoLocation\}\}/g, geo);
  const m = url.match(/^(\w+):\/\/(?:([^:@]+):([^@]*)@)?([^:/]+):(\d+)/);
  if (!m) throw new Error(`cannot parse HTTPS_PROXY_URL: ${raw}`);
  const [, scheme, username, password, host, port] = m;
  return { scheme, username, password, host, port: parseInt(port, 10) };
}

// Install a CDP Fetch.authRequired handler that answers the proxy's 407
// challenge with credentials (the __pcn extension sets the server only).
async function installProxyAuth(ctx, page, username, password) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  cdp.on('Fetch.requestPaused', async (e) => {
    try { await cdp.send('Fetch.continueRequest', { requestId: e.requestId }); } catch {}
  });
  cdp.on('Fetch.authRequired', async (e) => {
    try {
      await cdp.send('Fetch.continueWithAuth', {
        requestId: e.requestId,
        authChallengeResponse: { response: 'ProvideCredentials', username, password },
      });
    } catch {}
  });
  console.log('[utils] proxy auth handler installed');
}

export async function connect({ proxyAuth = false } = {}) {
  await resetViewportBaseline();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  if (PROXY_URL) {
    // Set the proxy server via the bundled __pcn extension (preserves kiosk
    // context), substituting the country, then handle auth over CDP.
    const p = parseProxyUrl(PROXY_URL, PROXY_GEO);
    const scheme = PROXY_SCHEME || p.scheme;
    // __pcn is injected by a content script and only exists on http(s) pages,
    // never about:blank. Bootstrap it on a proxy-bypassed local page so this
    // works even if a bad proxy is already set.
    const hasPcn = await page.evaluate(() => !!(window.__pcn && window.__pcn.ready)).catch(() => false);
    if (!hasPcn) {
      await page.goto(BOOTSTRAP_URL, { timeout: 10000 }).catch(() => {});
      await page.waitForFunction(() => !!(window.__pcn && window.__pcn.ready), { timeout: 5000 }).catch(() => {});
    }
    const res = await page.evaluate(
      (cfg) => (window.__pcn ? window.__pcn.set(cfg) : { error: '__pcn unavailable' }),
      { host: p.host, port: p.port, scheme }
    ).catch((e) => ({ error: e.message }));
    // Pin a sticky exit IP: append -session-<id> to the BrightData username
    // (only if it doesn't already carry one). This is what stops the per-request
    // IP rotation that floors reCAPTCHA v3.
    const stickyUser = p.username && !/-session-/.test(p.username)
      ? `${p.username}-session-${PROXY_SESSION}`
      : p.username;
    console.log(`[utils] proxy via __pcn → ${scheme}://${p.host}:${p.port} (geo=${PROXY_GEO}, session=${PROXY_SESSION})`, res);
    if (stickyUser && p.password) await installProxyAuth(ctx, page, stickyUser, p.password);
  } else if (proxyAuth && existsSync(CREDS_PATH)) {
    const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
    await installProxyAuth(ctx, page, creds.username, creds.password);
  }

  return { browser, ctx, page };
}

// Approximates a human looking at a page: mouse moves with multi-step
// interpolation (Akamai watches inter-event timing), smooth scrolls
// (sensor records scroll deltas), dwell pauses. Wrapped in try/catch
// so navigation races don't tank the probe.
export async function humanize(page, { rounds = 4, dwell = 1500 } = {}) {
  for (let i = 0; i < rounds; i++) {
    try {
      await page.mouse.move(200 + i*100, 200 + i*80, { steps: 12 });
      await page.evaluate(y => window.scrollTo({top: y, behavior: 'smooth'}), 200 + i*250).catch(()=>{});
      await page.waitForTimeout(dwell);
    } catch {}
  }
  await page.waitForTimeout(4000);
}

export async function readCookie(ctx, host, name) {
  const cookies = await ctx.cookies(host);
  return cookies.find(c => c.name === name) || null;
}

// Parse Akamai _abck verdict token: cookie format is
//   <sensorId>~<verdict>~<sensor>~<v2>~<v3>~<expiry>~<challenge>~<refresh>
// Token "0" = PASS, "-1" = BOT/pending, "8" = invalid sensor.
export function parseAbck(cookie) {
  if (!cookie) return null;
  const m = cookie.value.match(/~([\-0-9]+)~/);
  return { token: m ? m[1] : null, len: cookie.value.length };
}

export function pass(token)  { return token === '0'; }
export function fail(token)  { return token === '-1' || token === null; }

async function resetViewportBaseline() {
  if (!RESET_VIEWPORT) return;
  try {
    await fetch(`${NOVNC_BASE_URL}/screen/restore`, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 350));
  } catch (e) {
    console.warn(`[utils] viewport reset skipped: ${e.message}`);
  }
}

export function section(label) {
  const bar = '─'.repeat(Math.max(0, 60 - label.length));
  console.log(`\n── ${label} ${bar}`);
}

export function summary(rows) {
  console.log('\n══ SUMMARY ════════════════════════════════════════════════');
  const w = Math.max(...rows.map(r => r.name.length));
  for (const r of rows) {
    const mark = r.pass ? '✓' : r.warn ? '!' : '✗';
    console.log(`  ${mark}  ${r.name.padEnd(w)}  ${r.detail || ''}`);
  }
  console.log('═══════════════════════════════════════════════════════════');
}
