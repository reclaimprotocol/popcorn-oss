// Capture RESPONSE BODIES from an already-running popcorn staging session.
//
// Why this exists. On australiansuper the login POST /api/loginpassword comes
// back 200 with a 41-byte body and the SPA stays on /login — stuck. A raw curl
// to the same endpoint gets Akamai's 403 "Access Denied", so the popcorn
// browser is PASSING Akamai; the stall is whatever those 41 bytes say. The
// reclaim-portal interceptor logs only responseBodyBytes=41, never the content,
// so the actual answer is invisible. This prints it.
//
// It attaches out-of-band (like popcorn-stg-inspect.mjs), enables the CDP
// Network domain, and dumps the request+response body of any URL matching
// MATCH. It never types or navigates — you drive the login by hand in the live
// view and this records what the network actually returned.
//
// Usage:
//   POPCORN_STAGING_CLIENT_ID=... POPCORN_STAGING_CLIENT_SECRET=... \
//   SESSION_ID=1786055876432 \
//   MATCH='loginpassword|/api/' node popcorn-stg-netcap.mjs
//
// Then perform the login in the live view. Ctrl-C when done.

import { chromium } from 'playwright-core';

const STAGING_CP_URL = process.env.POPCORN_STAGING_CP_URL
  || 'https://popcorn-cp-gcp-asia-south1-stg.reclaimprotocol.org';
const CLIENT_ID = process.env.POPCORN_STAGING_CLIENT_ID || process.env.POPCORN_CLIENT_ID;
const CLIENT_SECRET = process.env.POPCORN_STAGING_CLIENT_SECRET || process.env.POPCORN_CLIENT_SECRET;
const SESSION_ID = process.env.SESSION_ID;
// Default matches the australiansuper auth calls; override for other targets.
const MATCH = new RegExp(process.env.MATCH || 'loginpassword|/api/(login|auth|mfa|otp|challenge)', 'i');
const MAX_BODY = parseInt(process.env.MAX_BODY || '4000', 10);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set POPCORN_STAGING_CLIENT_ID / POPCORN_STAGING_CLIENT_SECRET.');
  process.exit(1);
}
if (!SESSION_ID) {
  console.error('Set SESSION_ID to the running session id.');
  process.exit(1);
}

const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${CLIENT_ID}:${CLIENT_SECRET}` };
const toWs = (u) => u.replace(/^(https?|wss?):\/\//, 'wss://');

function truncate(s) {
  if (s == null) return s;
  return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}… [${s.length} bytes total]` : s;
}

let browser;
try {
  const res = await fetch(`${STAGING_CP_URL}/v1/sessions/${encodeURIComponent(SESSION_ID)}`, { headers: authHeaders });
  if (!res.ok) throw new Error(`fetch session: ${res.status} ${await res.text()}`);
  const s = await res.json();
  if (!s.cdpInternalUrl) throw new Error('no cdpInternalUrl on this session');

  browser = await chromium.connectOverCDP(toWs(s.cdpInternalUrl), { timeout: 60000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);

  // Keep request bodies (POST payloads) so a stuck login can be read as
  // request→response in one place. Credentials will appear here — this is a
  // debugging tool, don't pipe its output anywhere it gets retained.
  const reqBodies = new Map();
  await cdp.send('Network.enable', { maxResourceBufferSize: 10 * 1024 * 1024, maxTotalBufferSize: 50 * 1024 * 1024 });

  cdp.on('Network.requestWillBeSent', (e) => {
    if (MATCH.test(e.request.url)) reqBodies.set(e.requestId, { url: e.request.url, method: e.request.method, postData: e.request.postData });
  });

  cdp.on('Network.responseReceived', async (e) => {
    if (!MATCH.test(e.response.url)) return;
    const meta = reqBodies.get(e.requestId) || {};
    // Body isn't available until the response finishes loading; small delay,
    // then pull it over CDP (playwright's response.body() isn't wired to an
    // out-of-band CDP-attached page).
    setTimeout(async () => {
      let body = '(unavailable)';
      try {
        const r = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
        body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      } catch (err) {
        body = `(getResponseBody failed: ${err.message})`;
      }
      console.log('\n══════════════════════════════════════════════════════');
      console.log(`${meta.method || e.response.status} ${e.response.url}`);
      console.log(`status : ${e.response.status} ${e.response.statusText}`);
      console.log(`ctype  : ${e.response.headers['content-type'] || e.response.headers['Content-Type'] || '?'}`);
      if (meta.postData) console.log(`request: ${truncate(meta.postData)}`);
      console.log(`body   : ${truncate(body)}`);
      console.log('══════════════════════════════════════════════════════');
    }, 400);
  });

  console.log(`[netcap] attached to session ${SESSION_ID}`);
  console.log(`[netcap] matching: ${MATCH}`);
  console.log('[netcap] now drive the login in the live view — bodies print here. Ctrl-C to stop.\n');
  await new Promise(() => {});
} catch (err) {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch {}
}
