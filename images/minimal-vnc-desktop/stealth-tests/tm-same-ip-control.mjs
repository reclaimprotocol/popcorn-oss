// Same-IP control: drive the HOST's stock Google Chrome through the exact same
// BrightData exit the popcorn pod used, at the same target.
//
// Why this exists. The Mumbai pod got PerimeterX's "Your browsing activity has
// been paused" on ticketmaster.com/member from an Indian residential IP. Two
// explanations fit that equally well — the IP pool is burned, or the pod's
// browser fingerprint is. The pod run cannot tell them apart because it varies
// both at once.
//
// So hold the IP constant and swap only the browser. Pin PROXY_SESSION to the
// SAME value for this run and the pod run, and BrightData gives both the same
// exit IP. Then:
//
//   host Chrome PASSES, pod FAILS  -> the IP is fine; it's the pod fingerprint
//   both FAIL                      -> IP reputation; fingerprint is exonerated
//   both PASS                      -> the trigger was the navigation path
//                                     (cold jar / direct-to-auth), not either
//
// PATH mirrors the pod exactly by default (straight to the target, no site
// history) so the comparison is honest. Set PATH_MODE=human to instead land on
// the homepage, dwell, and navigate in — that tests the third hypothesis.
//
// Usage:
//   PROXY_SESSION=tmctl1 node tm-same-ip-control.mjs
//   PROXY_SESSION=tmctl1 PATH_MODE=human node tm-same-ip-control.mjs
//
// Reads the proxy credential from reclaim-portal's .env by default so it never
// has to be pasted on a command line. Never log the assembled URL.

import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const ENV_FILE = process.env.PORTAL_ENV
  // Relative to this file, assuming reclaim-portal sits alongside popcorn-oss.
  // Override with PORTAL_ENV if your checkout differs. Read at runtime only —
  // the credential is never written into this repo.
  || new URL('../../../../../reclaim-portal/packages/browser-events/.env', import.meta.url).pathname;
const TARGET = process.env.TARGET || 'https://www.ticketmaster.com/member';
const GEO = process.env.PROXY_GEO || 'in';
const SESSION = (process.env.PROXY_SESSION || 'tmctl1').replace(/[^a-zA-Z0-9]/g, '');
const PATH_MODE = process.env.PATH_MODE || 'direct';
const HEADFUL = String(process.env.HEADFUL || 'true').toLowerCase() !== 'false';

function fromEnvFile(key) {
  const line = readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in ${ENV_FILE}`);
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
}

// PROXY=off is the baseline every other run is measured against: if a direct
// connection also gets the interstitial, the proxy is not the variable and
// something about the whole test setup is being scored. Without this control
// "every proxy run is blocked" proves nothing.
const PROXY_OFF = String(process.env.PROXY || '').toLowerCase() === 'off';

const user = PROXY_OFF ? null : `${fromEnvFile('PROXY_USERNAME')}-country-${GEO}-session-${SESSION}`;
const pass = PROXY_OFF ? null : fromEnvFile('PROXY_PASSWORD');
const server = PROXY_OFF ? null : fromEnvFile('PROXY_SERVER'); // http://brd.superproxy.io:33335

const BLOCK_RE = /pardon the interruption|browsing activity has been paused|access denied|incapsula incident id|request unsuccessful|verify you are a human|are you a robot/i;

console.log(PROXY_OFF
  ? `[control] host Chrome -> DIRECT (no proxy, your own IP) path=${PATH_MODE}`
  : `[control] host Chrome -> ${server} country=${GEO} session=${SESSION} path=${PATH_MODE}`);

// channel:'chrome' uses the installed Google Chrome, not playwright's bundled
// chromium. That alone is NOT a consumer baseline: a plain
// chromium.launch({channel:'chrome'}) still sets navigator.webdriver=true and
// passes --enable-automation, and PerimeterX treats webdriver as a hard tell.
// A control carrying that flag gets blocked from every IP on earth, which
// makes it useless for attributing a block to the network — it silently
// "confirms" whatever you were hoping to prove.
//
// So strip the automation surface: drop --enable-automation, disable the
// AutomationControlled blink feature (this is what clears navigator.webdriver),
// and use a persistent profile so there is a real cookie jar rather than the
// blank one a fresh context presents.
//
// Even so this is only an APPROXIMATION of a consumer browser. The definitive
// baseline is a human opening the URL in their own everyday Chrome. Verify
// with `assertNotAutomated` below before trusting any verdict from this file.
const ctxDir = process.env.CONTROL_PROFILE || '/tmp/tm-control-profile';
const ctx = await chromium.launchPersistentContext(ctxDir, {
  channel: 'chrome',
  headless: !HEADFUL,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
  ...(PROXY_OFF ? {} : { proxy: { server, username: user, password: pass } }),
});
const browser = ctx.browser();

try {
  const page = ctx.pages()[0] || await ctx.newPage();

  // Refuse to report a verdict from a browser that still announces itself.
  // A blocked run from an automated control tells you nothing about the IP,
  // so fail loudly rather than emit a misleading PASS/FAIL.
  await page.goto('about:blank').catch(() => {});
  const automated = await page.evaluate(() => navigator.webdriver).catch(() => null);
  if (automated) {
    console.error('\n[control] ABORT: navigator.webdriver is still true.');
    console.error('[control] This browser is detectable as automated, so any block');
    console.error('[control] it receives is unattributable. Verdict suppressed.\n');
    process.exitCode = 2;
    throw new Error('control browser is automation-flagged');
  }
  console.log('[control] navigator.webdriver =', automated, '— control is usable');

  const egress = await page.goto('https://geo.brdtest.com/mygeo.json', { waitUntil: 'domcontentloaded', timeout: 60000 })
    .then(() => page.evaluate(() => document.body?.innerText || ''))
    .catch((e) => `(failed: ${e.message})`);
  const ip = (egress.match(/"ip"\s*:\s*"([^"]+)"/) || [])[1];
  console.log('[control] egress:', egress.replace(/\s+/g, ' ').slice(0, 200));

  if (PATH_MODE === 'human') {
    // Arrive like a person: homepage first, dwell, let PX bank a _px3 on a
    // low-scrutiny page, then move to the sign-in flow.
    await page.goto('https://www.ticketmaster.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(200 + i * 120, 220 + i * 90, { steps: 14 }).catch(() => {});
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), 300 + i * 320).catch(() => {});
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(4000);
    console.log('[control] homepage settled, moving to sign-in');
  }

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => {
    console.log('[control] nav err:', e.message);
  });

  // Resample through the OAuth redirect chain — the same destroyed-context
  // trap that made the pod run print undefined.
  //
  // "First non-empty page" is NOT good enough: /member renders a cookie
  // banner for a moment before bouncing to auth.ticketmaster.com, and
  // sampling there reports a pass for a flow that gets blocked one redirect
  // later. Require the URL to stop moving between two reads.
  let v, prevUrl = null, stableFor = 0;
  for (let i = 0; i < 10; i++) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    v = await page.evaluate(() => {
      const text = (() => { try { return document.body?.innerText || ''; } catch (_) { return ''; } })();
      return {
        url: location.href,
        title: document.title,
        len: text.length,
        head: text.replace(/\s+/g, ' ').slice(0, 260),
        px: !!document.querySelector('#px-captcha, [id^="px-captcha"]'),
      };
    }).catch((e) => ({ error: e.message }));
    if (!v.error && v.len > 0) {
      stableFor = v.url === prevUrl ? stableFor + 1 : 0;
      prevUrl = v.url;
      // Two consecutive reads at the same URL, and past the entry path.
      if (stableFor >= 1 && !/\/member\/?$/.test(v.url)) break;
      // A block page is terminal — no point waiting for it to settle further.
      if (BLOCK_RE.test(`${v.title}\n${v.head}`) || v.px) break;
    }
    await page.waitForTimeout(5000);
  }

  const blocked = v.error ? null : (BLOCK_RE.test(`${v.title}\n${v.head}`) || v.px);
  console.log('\n===== CONTROL RESULT =====');
  console.log('browser :', 'host Google Chrome (stock)');
  console.log('exit ip :', ip || '(unknown)');
  console.log('path    :', PATH_MODE);
  console.log('url     :', v.error ? `(evaluate failed: ${v.error})` : v.url);
  console.log('title   :', v.title);
  console.log('blocked :', blocked === null ? 'UNKNOWN (no sample)' : blocked ? 'YES — interstitial' : 'no');
  console.log('text    :', v.head);
  console.log('==========================\n');
} finally {
  await browser.close();
}
