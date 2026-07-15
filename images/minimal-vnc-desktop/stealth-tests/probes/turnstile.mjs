// Cloudflare Turnstile non-interactive probe.
//
// Turnstile has three modes:
//   1. non-interactive (invisible) — challenge runs silently, validates
//      a token, success returned automatically.
//   2. managed         — CF picks per-request based on risk score.
//   3. visible         — explicit checkbox the user clicks.
//
// peet.ws/turnstile-test/non-interactive.html is configured for mode 1.
// PASS = Turnstile silently issues a response token without us touching
// the page. FAIL = it falls back to a visible challenge / never resolves.
//
// We detect success by polling for either:
//   - the hidden <input name="cf-turnstile-response"> getting a non-empty
//     value (this is where the JWT-shaped token lands on completion),
//   - or the widget iframe's success state (a known DOM marker).
// Timeout is 25s — real Chrome on a clean residential IP usually resolves
// in 2-4s.

import { connect, section, summary } from '../utils.mjs';

const TURNSTILE_URL = 'https://peet.ws/turnstile-test/non-interactive.html';

export async function run({ closeBrowser = true } = {}) {
  const { browser, page } = await connect();
  section('Cloudflare Turnstile (non-interactive)');

  let token = null, elapsedMs = null, err = null;
  const start = Date.now();
  try {
    await page.goto(TURNSTILE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Poll up to 25s for a token. Turnstile renders the iframe + writes
    // the response token to a hidden input on success. The input name
    // is "cf-turnstile-response" by default; some embeds rename it via
    // data-response-field-name. Cover both.
    const result = await page.evaluate(async () => {
      const deadline = Date.now() + 25000;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      while (Date.now() < deadline) {
        // 1. Any hidden input whose name starts with cf-turnstile-response
        const inputs = Array.from(document.querySelectorAll('input[type="hidden"]'));
        for (const inp of inputs) {
          const n = inp.name || '';
          if (/^cf-turnstile-response/i.test(n) && inp.value && inp.value.length > 20) {
            return { ok: true, token: inp.value, source: `input[name=${n}]` };
          }
        }
        // 2. window.turnstile?.getResponse() if the global is exposed
        if (typeof window.turnstile !== 'undefined' && typeof window.turnstile.getResponse === 'function') {
          try {
            const t = window.turnstile.getResponse();
            if (t && t.length > 20) return { ok: true, token: t, source: 'turnstile.getResponse()' };
          } catch {}
        }
        // 3. Fallback: a textarea[name=g-recaptcha-response] pattern Turnstile
        //    sometimes uses for drop-in recaptcha compat
        const ta = document.querySelector('textarea[name^="cf-turnstile-response"]');
        if (ta && ta.value && ta.value.length > 20) {
          return { ok: true, token: ta.value, source: 'textarea' };
        }
        await sleep(500);
      }
      // Snapshot the DOM at timeout for diagnostics
      return {
        ok: false,
        snippet: document.body.innerText.slice(0, 400),
        inputs: Array.from(document.querySelectorAll('input,textarea')).map(e => ({
          tag: e.tagName, name: e.name, valueLen: (e.value || '').length,
        })),
      };
    });

    elapsedMs = Date.now() - start;
    if (result.ok) {
      token = result.token;
      console.log(`  ✓ token (${token.length} chars) via ${result.source} in ${elapsedMs}ms`);
      console.log(`    token head: ${token.slice(0, 40)}...`);
    } else {
      console.log(`  ✗ no token after ${elapsedMs}ms`);
      console.log('    body snippet:', result.snippet);
      console.log('    inputs:', JSON.stringify(result.inputs));
    }
  } catch (e) {
    err = e.message;
    console.log('  nav/eval err:', err);
  }

  if (closeBrowser) await browser.close();
  return [{
    name: 'CF Turnstile (NI)',
    pass: !!token,
    detail: token ? `auto-validated in ${elapsedMs}ms` : err || 'no token issued',
  }];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
