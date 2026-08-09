// Launch a Popcorn STAGING session (asia-south1 / Mumbai), put it behind the
// proxy the same way reclaim-portal does, and report what the site actually sees.
//
// The point of this script is to isolate ONE variable. A deployed portal session
// gets Akamai's "Access Denied" on australiansuper while the same browser image
// run locally does not, so the question is whether the egress IP explains it.
// Here there is no reclaim-portal in the loop at all: no reclaim_env.js, no
// login_script.js, no hawkeye, no stealth_init — just the popcorn browser, the
// proxy, and the target. If this passes with the proxy and fails without it, the
// IP is the cause and the injection is exonerated.
//
// It mirrors reclaim-portal's own path exactly (packages/browser-events/src):
//   modules/providers/popcorn-providers.ts  → create session, connectOverCDP(cdpInternalUrl)
//   utils/popcorn/proxy.ts                  → __pcn.set() then CDP Fetch auth
// The extension only ever receives host/port — it cannot do auth (chrome.proxy
// has no credential field), so the 407 is answered over CDP Fetch. That is why
// both halves are required and why order matters: set the proxy first, arm the
// auth handler second, navigate last. Navigating before the handler is armed
// yields net::ERR_INVALID_AUTH_CREDENTIALS.
//
// Usage:
//   export POPCORN_CLIENT_ID=...  POPCORN_CLIENT_SECRET=...
//   export PROXY_URL='http://brd-customer-...-country-{{geoLocation}}:PASS@brd.superproxy.io:44445'
//   node popcorn-stg-proxy-check.mjs
//
//   PROXY=off node popcorn-stg-proxy-check.mjs      # control run: no proxy
//   TARGET=https://portal.australiansuper.com/login node popcorn-stg-proxy-check.mjs
//
// PROXY_URL is a credential — pass it via env, never commit it.

import { chromium } from 'playwright-core';

// Staging gateway + control plane, from reclaim-portal's POPCORN_DEFAULTS
// (packages/shared/src/constants.ts). Staging only knows asia-south1, which is
// the Mumbai region we want anyway.
const STAGING_URL = process.env.POPCORN_STAGING_URL
  || 'https://popcorn-gateway-gcp-asia-south1-staging.reclaimprotocol.org';
const STAGING_CP_URL = process.env.POPCORN_STAGING_CP_URL
  || 'https://popcorn-cp-gcp-asia-south1-stg.reclaimprotocol.org';
const REGION = 'asia-south1';

const CLIENT_ID = process.env.POPCORN_STAGING_CLIENT_ID || process.env.POPCORN_CLIENT_ID;
const CLIENT_SECRET = process.env.POPCORN_STAGING_CLIENT_SECRET || process.env.POPCORN_CLIENT_SECRET;
const PROXY_URL = process.env.PROXY_URL || process.env.HTTPS_PROXY_URL || '';
const PROXY_OFF = String(process.env.PROXY || '').toLowerCase() === 'off';
const GEO = process.env.PROXY_GEO || 'in';
// Sticky exit. Without one BrightData rotates the IP per request, which both
// tanks reCAPTCHA v3 and makes a reputation reading meaningless. Alphanumeric
// only — a dash in the session id breaks BrightData auth (407 client_10001).
const SESSION = (process.env.PROXY_SESSION || `s${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9]/g, '');
const TARGET = process.env.TARGET || 'https://portal.australiansuper.com/login';
// Comma-separated reclaim-portal script basenames to replay into this session.
// Empty (default) = the clean baseline with no portal involvement at all.
const INJECT = (process.env.INJECT || '').split(',').map((s) => s.trim()).filter(Boolean);
const PORTAL_SCRIPTS = process.env.PORTAL_SCRIPTS
  // Relative to this file, assuming reclaim-portal sits alongside popcorn-oss.
  // Override with PORTAL_SCRIPTS if your checkout differs.
  || new URL('../../../../../reclaim-portal/packages/browser-events/scripts', import.meta.url).pathname;
const KEEP = String(process.env.KEEP || '').toLowerCase() === 'true';
// Park the session with the CDP client CLOSED, so nothing is attached while
// you browse. See the DETACH block below for why that is the variable worth
// isolating for PerimeterX-fronted sites.
const DETACH = String(process.env.DETACH || '').toLowerCase() === 'true';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set POPCORN_CLIENT_ID and POPCORN_CLIENT_SECRET (or the POPCORN_STAGING_* pair).');
  process.exit(1);
}
if (!PROXY_OFF && !PROXY_URL) {
  console.error('Set PROXY_URL (or run with PROXY=off for the control run).');
  process.exit(1);
}

const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${CLIENT_ID}:${CLIENT_SECRET}` };
const sessionId = String(process.env.SESSION_ID || Date.now());

// --- proxy parsing, matching utils/popcorn/proxy.ts parseProxyConfig ----------
// The portal is handed {host, port, username, password} by the provider config;
// here we accept a single URL and split it, substituting {{geoLocation}} and
// appending the sticky session the same way the rest of the tooling does.
function parseProxyUrl(raw) {
  const url = raw.replace(/\{\{geoLocation\}\}/g, GEO);
  const m = url.match(/^(\w+):\/\/(?:([^:@]+):([^@]*)@)?([^:/]+):(\d+)/);
  if (!m) throw new Error(`cannot parse PROXY_URL: ${raw.replace(/:[^:@/]*@/, ':***@')}`);
  const [, , username, password, host, port] = m;
  const user = username && !/-session-/.test(username) ? `${username}-session-${SESSION}` : username;
  return { host, port: parseInt(port, 10), username: user, password };
}

// --- session lifecycle, matching popcorn-providers.ts ------------------------
async function createSession() {
  // Staging control plane only accepts asia-south1; sending the multi-region
  // fallback list 400s with "Unknown region: us-central1".
  const res = await fetch(`${STAGING_CP_URL}/v1/sessions`, {
    method: 'POST',
    headers: authHeaders,
    // sessionId MUST be a string — an all-digit value decoded as a JS Number
    // fails popcorn's schema.
    body: JSON.stringify({ sessionId, regions: [REGION] }),
  });
  if (res.status === 409) {
    const existing = await fetch(`${STAGING_CP_URL}/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: authHeaders });
    if (!existing.ok) throw new Error(`fetch existing session: ${existing.status} ${await existing.text()}`);
    return existing.json();
  }
  if (!res.ok) throw new Error(`create session: ${res.status} ${await res.text()}`);
  return res.json();
}

async function killSession() {
  try {
    await fetch(`${STAGING_CP_URL}/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: authHeaders });
    console.log('[cleanup] session deleted');
  } catch (e) {
    console.log('[cleanup] delete failed:', e.message);
  }
}

const toWs = (u) => u.replace(/^(https?|wss?):\/\//, 'wss://');

// Park forever. `await new Promise(() => {})` is NOT enough: with no pending
// handles Node sees an unsettled top-level await, warns, and exits 13 — which
// is exactly why earlier KEEP runs died instead of holding the session open
// (and why the finally block never ran to clean up). An interval keeps a live
// handle on the event loop so the process actually stays up.
const park = () => new Promise(() => { setInterval(() => {}, 1 << 30); });

// --- main --------------------------------------------------------------------
let browser;
try {
  console.log(`[popcorn] creating staging session ${sessionId} in ${REGION}…`);
  const s = await createSession();
  console.log(`[popcorn] pod=${s.browserPodId ?? 'n/a'} region=${s.region ?? REGION} cluster=${s.clusterName ?? 'n/a'}`);
  // The gateway returns the live view as http:// even when reached over https;
  // browsers refuse the mixed-content iframe, so normalise it like the portal does.
  const liveUrl = s.url ? s.url.replace(/^http:\/\//, 'https://') : '';
  if (liveUrl) console.log(`[popcorn] LIVE VIEW: ${liveUrl}`);
  // The backend uses cdpInternalUrl: the restricted endpoint filters out the
  // Fetch/Runtime commands proxy auth and this check need.
  if (!s.cdpInternalUrl) throw new Error('gateway returned no cdpInternalUrl (need the internal scope for CDP Fetch)');

  browser = await chromium.connectOverCDP(toWs(s.cdpInternalUrl), { timeout: 60000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());

  if (!PROXY_OFF) {
    const proxy = parseProxyUrl(PROXY_URL);
    console.log(`[proxy] ${proxy.host}:${proxy.port} geo=${GEO} session=${SESSION}`);

    // 1. Extension sets the proxy SERVER only (chrome.proxy has no credential
    //    field). __pcn is injected by the content script, which only runs on
    //    real pages — hence the about:blank bootstrap inside the helper.
    const ready = await page.evaluate(() => !!window.__pcn?.ready).catch(() => false);
    if (!ready) {
      await page.goto('about:blank').catch(() => {});
      await page.waitForFunction(() => !!window.__pcn?.ready, { timeout: 5000 }).catch(() => {});
    }
    if (!(await page.evaluate(() => !!window.__pcn?.ready).catch(() => false))) {
      throw new Error('__pcn not available — is the proxy extension loaded in this image?');
    }
    const setResult = await page.evaluate((cfg) => window.__pcn.set(cfg), {
      host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password,
    });
    console.log('[proxy] __pcn.set →', setResult);

    // 2. CDP Fetch answers the 407 the extension cannot. Armed BEFORE any
    //    navigation: a nav that races this returns ERR_INVALID_AUTH_CREDENTIALS.
    const cdp = await context.newCDPSession(page);
    let authHandled = false;
    cdp.on('Fetch.authRequired', async (p) => {
      try {
        await cdp.send('Fetch.continueWithAuth', {
          requestId: p.requestId,
          authChallengeResponse: { response: 'ProvideCredentials', username: proxy.username, password: proxy.password },
        });
        if (!authHandled) {
          authHandled = true;
          console.log('[proxy] auth challenge answered');
          // Chrome caches credentials per host:port after the first auth, so
          // drop interception immediately — leaving Fetch enabled adds a CDP
          // round-trip per request and depresses bot scores.
          await cdp.send('Fetch.disable').catch(() => {});
          console.log('[proxy] Fetch.disable — interception removed');
        }
      } catch (e) {
        console.error('[proxy] auth error:', e.message);
      }
    });
    cdp.on('Fetch.requestPaused', (p) => {
      cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    });
    await cdp.send('Fetch.enable', { handleAuthRequests: true });
    console.log('[proxy] Fetch.enable — waiting for the challenge');
  } else {
    console.log('[proxy] DISABLED (control run) — egress is the cluster IP');
  }

  // Optional: replay reclaim-portal's own page injection into this otherwise
  // clean session, so the portal's scripts can be bisected against a baseline
  // that is known to pass. Mirrors web-page-manager.ts setupUserScripts, which
  // addInitScript's reclaim_env.js then login_script.js (in that order —
  // reclaim_env must run first so window.Reclaim exists), then seeds
  // Reclaim.provider / Reclaim.parameters.
  //   INJECT=reclaim_env                     → just the runtime
  //   INJECT=reclaim_env,login_script        → what a CDP-path portal session gets
  //   INJECT=reclaim_env,login_script,hawkeye → adds the fetch/XHR Proxy
  if (INJECT.length) {
    for (const name of INJECT) {
      const path = `${PORTAL_SCRIPTS}/${name}.js`;
      await context.addInitScript({ path });
      console.log(`[inject] addInitScript ${name}.js`);
    }
    // The portal always follows the scripts with this seed.
    await context.addInitScript(() => {
      try {
        window.Reclaim.provider = {};
        window.Reclaim.parameters = {};
      } catch (_) { /* Reclaim absent when only a subset was injected */ }
    });
    console.log('[inject] Reclaim.provider/parameters seeded');
  }

  // Egress reading first: this is the measurement the whole test exists for.
  await page.goto('https://geo.brdtest.com/mygeo.json', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
    console.log('[egress] navigation failed:', e.message);
  });
  const egress = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  console.log('[egress]', egress.trim().slice(0, 300) || '(no reading)');

  // DETACH: park the session with NO CDP client attached.
  //
  // TARGET=none parks the pod but this process keeps its CDP connection open,
  // which leaves the Runtime/Page domains enabled for as long as you browse.
  // That matters: PerimeterX blocked ticketmaster.com from every CDP-driven
  // browser we tried — the Fortress pod, and a de-flagged stock Chrome, from
  // Indian residential, US residential, and a direct home connection — while a
  // plain curl from the SAME home IP got a clean 200 and the real homepage.
  // The IP is therefore not the variable; an attached debugger is the one
  // thing every blocked run shared.
  //
  // So disconnect before browsing. Proxy auth survives it: Chrome caches
  // credentials per host:port after the first challenge (which the egress
  // navigation above already triggered), and the extension holds the proxy
  // server setting independently of CDP. Closing a connectOverCDP client only
  // drops the playwright wrapper — the pod and its chromium keep running.
  //
  // Read the result in the live view, by hand:
  //   loads normally -> CDP attachment is the trigger; fix is on our side
  //   still blocked  -> attachment is exonerated, look at the Fortress surface
  if (DETACH) {
    // Optionally land on the target before dropping CDP. `waitUntil: 'commit'`
    // returns as soon as the navigation commits — before the document's
    // scripts run — so we can close the connection while the PerimeterX
    // sensor is still ahead of us. The fingerprinting therefore happens with
    // no debugger attached, which is the whole point of this mode.
    //
    // This exists because staging exposes no GET /v1/sessions/{id} (verified:
    // it and the list endpoint both 404), so once this process drops CDP there
    // is no way to re-attach and steer the session. If you want it parked on a
    // specific URL, it has to be done here, on the way out.
    if (TARGET && TARGET !== 'none') {
      console.log(`[detach] committing navigation to ${TARGET} before detaching…`);
      await page.goto(TARGET, { waitUntil: 'commit', timeout: 60000 }).catch((e) => {
        console.log('[detach] nav failed:', e.message);
      });
    }
    await browser.close().catch(() => {});
    browser = undefined; // stop the finally block from double-closing
    console.log('\n[detach] CDP client closed — nothing is attached to this browser now.');
    console.log('[detach] Open the live view and drive it by hand:');
    console.log(`  ${liveUrl}\n`);
    console.log('[detach] Ctrl-C exits and deletes the session.');
    process.on('SIGINT', async () => { await killSession(); process.exit(0); });
    await park();
  }

  // TARGET=none leaves the session parked on the egress reading so you can drive
  // it yourself from the live view — useful for actually attempting a login.
  if (TARGET === 'none') {
    console.log('\n[live view] open this and browse manually:');
    console.log(`  ${liveUrl}\n`);
    console.log('TARGET=none — not navigating. Ctrl-C to exit.');
    await park();
  }

  // Then the real target.
  console.log(`[target] ${TARGET}`);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => {
    console.log('[target] navigation failed:', e.message);
  });
  await page.waitForTimeout(8000); // let the SPA and the Akamai sensor settle

  // An OAuth entry point (ticketmaster.com/member) is still bouncing through
  // redirects well past 8s, and evaluating mid-navigation throws "Execution
  // context was destroyed" — which then printed a RESULT block full of
  // `undefined` and a misleading `blocked: no`. A destroyed context is a
  // RETRY, not a verdict: settle on load state and sample again.
  const evaluateVerdict = () => page.evaluate(() => {
    const text = (() => { try { return document.body?.innerText || ''; } catch (_) { return ''; } })();
    const btn = [...document.querySelectorAll('button')].find((b) => /next|log ?in|sign ?in/i.test(b.textContent || ''));
    return {
      url: location.href,
      title: document.title,
      // "Access Denied" + an edgesuite reference is Akamai's block page. The
      // rest cover the stacks other targets front with — PerimeterX's
      // "Pardon the Interruption" (ticketmaster), Imperva, generic captcha
      // interstitials — so this verdict is not Akamai-only.
      blocked: /access denied|don't have permission|reference #|pardon the interruption|browsing activity has been paused|incapsula incident id|request unsuccessful|verify you are a human|are you a robot/i.test(text)
        || !!document.querySelector('#px-captcha, [id^="px-captcha"]'),
      // The login form arming is the downstream symptom: on a blocked session
      // the SPA never enables it.
      button: btn ? { text: (btn.textContent || '').trim(), disabled: btn.disabled } : null,
      // Akamai hooks document.cookie. Reading it can THROW when its sensor
      // trips a cross-origin frame walk — that throw is itself a finding, so
      // record it rather than letting it abort the whole probe.
      cookieRead: (() => {
        try {
          const ck = document.cookie;
          // Which anti-bot stack answered is a finding in itself — report the
          // tokens present rather than assuming the target's vendor.
          const vendors = ['_abck', '_px3', '_pxvid', '_pxhd', 'incap_ses', 'visid_incap', 'datadome']
            .filter((n) => new RegExp(`(^|;\\s*)${n}[=_]`).test(ck));
          return { ok: true, hasAbck: /(^|;\s*)_abck=/.test(ck), vendors };
        }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })(),
      head: text.replace(/\s+/g, ' ').slice(0, 180),
    };
  });

  let verdict;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    verdict = await evaluateVerdict().catch((e) => ({ error: e.message }));
    if (!verdict.error && verdict.title !== undefined) break;
    console.log(`[verdict] attempt ${attempt} unusable (${verdict.error || 'no data'}) — resampling`);
    await page.waitForTimeout(5000);
  }

  if (verdict.error) console.log('[verdict] evaluate FAILED after retries:', verdict.error);
  console.log('\n===== RESULT =====');
  console.log("inject  :", INJECT.length ? INJECT.join(",") : "none (clean baseline)");
  console.log("proxy   :", PROXY_OFF ? 'OFF (control)' : `ON  geo=${GEO} session=${SESSION}`);
  console.log('url     :', verdict.url);
  console.log('title   :', verdict.title);
  console.log('blocked :', verdict.blocked ? 'YES — Akamai denied' : 'no');
  console.log('button  :', verdict.button ? `"${verdict.button.text}" disabled=${verdict.button.disabled}` : '(none found)');
  console.log('cookie  :', verdict.cookieRead
    ? (verdict.cookieRead.ok
        ? `readable, _abck ${verdict.cookieRead.hasAbck ? 'present' : 'absent'}`
          + `, antibot=[${(verdict.cookieRead.vendors || []).join(',') || 'none'}]`
        : `THROWS from Akamai hook → ${verdict.cookieRead.error}`)
    : 'n/a');
  console.log('text    :', verdict.head);
  console.log('==================\n');

  // NETCAP: sniff request/response BODIES for auth calls from inside this
  // process. It has to live here, not in a second attach-by-id tool, because
  // the staging control plane exposes no GET /v1/sessions/{id} (both it and
  // the list endpoint 404) — only POST. So the only handle on the session is
  // the CDP connection this process already holds. Armed before the KEEP park
  // so it's live while you drive the login by hand.
  //
  // This is what reads the "200 + 41 bytes, stuck" case: the portal logs the
  // response SIZE, never the body. Credentials appear in the POST payload —
  // local debug only, don't retain the output.
  if (KEEP && process.env.NETCAP) {
    const MATCH = new RegExp(process.env.NETCAP, 'i');
    const MAX_BODY = parseInt(process.env.NETCAP_MAX || '4000', 10);
    const trunc = (s) => (s == null ? s : s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}… [${s.length} bytes]` : s);
    const netcap = await context.newCDPSession(page);
    const reqs = new Map();
    await netcap.send('Network.enable');
    netcap.on('Network.requestWillBeSent', (e) => {
      if (MATCH.test(e.request.url)) reqs.set(e.requestId, { url: e.request.url, method: e.request.method, postData: e.request.postData });
    });
    netcap.on('Network.responseReceived', (e) => {
      if (!MATCH.test(e.response.url)) return;
      const meta = reqs.get(e.requestId) || {};
      setTimeout(async () => {
        let body = '(unavailable)';
        try {
          const r = await netcap.send('Network.getResponseBody', { requestId: e.requestId });
          body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        } catch (err) { body = `(getResponseBody failed: ${err.message})`; }
        console.log('\n══════════════════════════════════════════════════════');
        console.log(`${meta.method || ''} ${e.response.url}`);
        console.log(`status : ${e.response.status} ${e.response.statusText}`);
        console.log(`ctype  : ${e.response.headers['content-type'] || e.response.headers['Content-Type'] || '?'}`);
        if (meta.postData) console.log(`request: ${trunc(meta.postData)}`);
        console.log(`body   : ${trunc(body)}`);
        console.log('══════════════════════════════════════════════════════');
      }, 400);
    });
    console.log(`[netcap] armed, matching ${MATCH} — drive the login; auth bodies print below\n`);
  }

  if (KEEP) {
    console.log('[live view] session held open — open this to watch/drive it:');
    console.log(`  ${liveUrl}\n`);
    console.log('Ctrl-C to exit. The pod stays up until you delete the session:');
    console.log(`  curl -X DELETE -H "Authorization: Bearer $POPCORN_STAGING_CLIENT_ID:$POPCORN_STAGING_CLIENT_SECRET" \\`);
    console.log(`    ${STAGING_CP_URL}/v1/sessions/${sessionId}`);
    await park();
  }
} catch (err) {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
} finally {
  if (!KEEP) {
    // Disconnecting only drops the CDP client; the pod survives until deleted.
    try { await browser?.close(); } catch {}
    await killSession();
  }
}
