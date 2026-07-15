// Turn the running browser's proxy ON and hold auth open for manual browsing.
//
// Sets the BrightData proxy (from HTTPS_PROXY_URL, with {{geoLocation}}→PROXY_GEO
// and a sticky -session-<id>) via the __pcn extension, installs a persistent CDP
// Fetch.authRequired handler, optionally navigates to a URL, then STAYS RUNNING
// so the whole live-view session browses through the proxy with auth answered.
//
// Usage:
//   export HTTPS_PROXY_URL='https://brd-...-country-{{geoLocation}}:PASS@brd.superproxy.io:33335/'
//   PROXY_GEO=in PROXY_SESSION=warm1 node proxy-on.mjs "https://www.tajhotels.com/en-in/..."
//   # leave it running; Ctrl-C to stop holding auth (proxy stays set until __pcn.clear)
//
// NOTE: this keeps a CDP client attached (required to answer proxy auth), which
// slightly depresses reCAPTCHA v3 — fine for normal browsing/Akamai targets. For
// a true reCAPTCHA v3 reading, measure with no CDP attached.

import { chromium } from 'playwright-core';
import { parseProxyUrl } from './utils.mjs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9226';
const GEO = process.env.PROXY_GEO || 'us';
// Alphanumeric only — a dash/underscore in the session id breaks BrightData auth.
const SESSION = (process.env.PROXY_SESSION || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`).replace(/[^a-zA-Z0-9]/g, '');
const NOVNC_PORT = process.env.NOVNC_PORT || 6080;
const NAV = process.argv[2] || '';

if (!process.env.HTTPS_PROXY_URL) {
  console.error('Set HTTPS_PROXY_URL first.');
  process.exit(1);
}

const p = parseProxyUrl(process.env.HTTPS_PROXY_URL, GEO);
const scheme = process.env.PROXY_SCHEME || p.scheme;
const user = p.username && !/-session-/.test(p.username)
  ? `${p.username}-session-${SESSION}`
  : p.username;

const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();

// Bootstrap __pcn on a proxy-bypassed local page, then set the proxy server.
const hasPcn = await page.evaluate(() => !!(window.__pcn && window.__pcn.ready)).catch(() => false);
if (!hasPcn) {
  await page.goto(`http://127.0.0.1:${NOVNC_PORT}/liveview.html`, { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => !!(window.__pcn && window.__pcn.ready), { timeout: 5000 }).catch(() => {});
}
const res = await page.evaluate(
  (cfg) => (window.__pcn ? window.__pcn.set(cfg) : { error: '__pcn unavailable' }),
  { host: p.host, port: p.port, scheme }
).catch((e) => ({ error: e.message }));
console.log(`[proxy-on] ${scheme}://${p.host}:${p.port}  geo=${GEO}  session=${SESSION}`, res);

// Persistent auth handler. chromium requires a non-empty pattern set when
// handleAuthRequests is on, so we intercept all requests and immediately
// continue them (requestPaused handler below) while answering the 407.
const cdp = await ctx.newCDPSession(page);
await cdp.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
cdp.on('Fetch.requestPaused', async (e) => {
  try { await cdp.send('Fetch.continueRequest', { requestId: e.requestId }); } catch {}
});
cdp.on('Fetch.authRequired', async (e) => {
  try {
    await cdp.send('Fetch.continueWithAuth', {
      requestId: e.requestId,
      authChallengeResponse: { response: 'ProvideCredentials', username: user, password: p.password },
    });
  } catch (err) { console.error('[proxy-on] auth err', err.message); }
});
console.log('[proxy-on] auth handler live — leave this process running.');

if (NAV) {
  await page.goto(NAV, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .then(() => console.log('[proxy-on] navigated →', NAV))
    .catch((e) => console.log('[proxy-on] nav err:', e.message));
}

await new Promise(() => {}); // keep the auth handler alive
