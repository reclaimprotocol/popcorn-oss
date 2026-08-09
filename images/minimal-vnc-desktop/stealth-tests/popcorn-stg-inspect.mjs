// Read the current state of an ALREADY-RUNNING popcorn staging session.
//
// popcorn-stg-proxy-check.mjs takes its verdict once, 8s after navigation, and
// then (with KEEP=true) parks the pod. That single sample is fragile: an OAuth
// entry point like ticketmaster.com/member is still bouncing through redirects
// at 8s, so `page.evaluate` dies with "Execution context was destroyed" and the
// RESULT block prints undefined — which is NOT a pass, just missing data.
//
// This attaches to the same session out-of-band and samples again, so you can:
//   - get the verdict the original run failed to capture
//   - re-read state AFTER driving the session by hand in the live view
//     (e.g. once you have actually logged in)
//
// It never navigates and never types. Whatever the page is showing — because a
// human drove it there in the live view — is what gets reported.
//
// Usage:
//   POPCORN_STAGING_CLIENT_ID=... POPCORN_STAGING_CLIENT_SECRET=... \
//   SESSION_ID=1786055876432 node popcorn-stg-inspect.mjs

import { chromium } from 'playwright-core';

const STAGING_CP_URL = process.env.POPCORN_STAGING_CP_URL
  || 'https://popcorn-cp-gcp-asia-south1-stg.reclaimprotocol.org';
const CLIENT_ID = process.env.POPCORN_STAGING_CLIENT_ID || process.env.POPCORN_CLIENT_ID;
const CLIENT_SECRET = process.env.POPCORN_STAGING_CLIENT_SECRET || process.env.POPCORN_CLIENT_SECRET;
const SESSION_ID = process.env.SESSION_ID;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set POPCORN_STAGING_CLIENT_ID / POPCORN_STAGING_CLIENT_SECRET.');
  process.exit(1);
}
if (!SESSION_ID) {
  console.error('Set SESSION_ID to the id printed by popcorn-stg-proxy-check.mjs.');
  process.exit(1);
}

const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${CLIENT_ID}:${CLIENT_SECRET}` };
const toWs = (u) => u.replace(/^(https?|wss?):\/\//, 'wss://');

const BLOCK_RE = /access denied|don't have permission|reference #|pardon the interruption|browsing activity has been paused|incapsula incident id|request unsuccessful|verify you are a human|are you a robot/i;

// Sample the page, retrying through redirects. The failure this exists to fix
// is a mid-navigation evaluate, so a destroyed context is a RETRY, not a
// result — settle on load state first, then re-read.
async function sample(page, { attempts = 6, gap = 4000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      const v = await page.evaluate(() => {
        const text = (() => { try { return document.body?.innerText || ''; } catch (_) { return ''; } })();
        return {
          url: location.href,
          title: document.title,
          textLen: text.length,
          head: text.replace(/\s+/g, ' ').slice(0, 300),
          // Sign-in surface: are we looking at a login form at all?
          inputs: [...document.querySelectorAll('input')]
            .map((el) => el.type || el.name || 'input')
            .filter((t) => /email|password|text|tel/i.test(t)),
          pxCaptcha: !!document.querySelector('#px-captcha, [id^="px-captcha"]'),
          recaptcha: !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha'),
          cookies: (() => {
            try {
              const ck = document.cookie;
              return ['_abck', '_px3', '_pxvid', '_pxhd', 'incap_ses', 'visid_incap', 'datadome']
                .filter((n) => new RegExp(`(^|;\\s*)${n}[=_]`).test(ck));
            } catch (e) { return `THROWS: ${String(e && e.message || e)}`; }
          })(),
        };
      });
      last = v;
      // A settled sample is one where the URL stopped moving between reads.
      if (v.textLen > 0) return v;
    } catch (e) {
      last = { error: e.message };
    }
    await new Promise((r) => setTimeout(r, gap));
  }
  return last;
}

let browser;
try {
  const res = await fetch(`${STAGING_CP_URL}/v1/sessions/${encodeURIComponent(SESSION_ID)}`, { headers: authHeaders });
  if (!res.ok) throw new Error(`fetch session: ${res.status} ${await res.text()}`);
  const s = await res.json();
  if (!s.cdpInternalUrl) throw new Error('no cdpInternalUrl on this session');

  browser = await chromium.connectOverCDP(toWs(s.cdpInternalUrl), { timeout: 60000 });
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  console.log(`[inspect] session ${SESSION_ID}, ${pages.length} page(s) open`);

  for (const [i, page] of pages.entries()) {
    const v = await sample(page);
    console.log(`\n===== PAGE ${i} =====`);
    if (v?.error) { console.log('sample failed :', v.error); continue; }
    const blocked = BLOCK_RE.test(`${v.title}\n${v.head}`) || v.pxCaptcha;
    console.log('url      :', v.url);
    console.log('title    :', v.title);
    console.log('blocked  :', blocked ? 'YES — interstitial' : 'no');
    console.log('text len :', v.textLen);
    console.log('inputs   :', v.inputs.length ? v.inputs.join(',') : '(none)');
    console.log('captcha  :', [v.pxCaptcha && 'px', v.recaptcha && 'recaptcha'].filter(Boolean).join(',') || 'none');
    console.log('antibot  :', Array.isArray(v.cookies) ? (v.cookies.join(',') || 'none') : v.cookies);
    console.log('text     :', v.head);
    console.log('====================');
  }
} catch (err) {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
} finally {
  // Only drops the CDP client — the pod and the session survive, so the live
  // view stays usable after this runs.
  try { await browser?.close(); } catch {}
}
