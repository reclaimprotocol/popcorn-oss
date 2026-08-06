// reCAPTCHA v3 score probe.
//
// v3 is silent: there's no challenge UI, just a per-request score
// (0.0 = bot, 1.0 = human). The score is normally server-side only, so we
// use a public demo that surfaces it:
//   https://antcpt.com/score_detector/   ← Anti-CAPTCHA's score viewer
// which runs grecaptcha.execute() on a known site key and renders the
// numeric score in the DOM.
//
// Healthy real-Chrome target on a clean residential IP is 0.7-0.9. Below
// 0.3 means reCAPTCHA flagged us hard; 0.3-0.6 is borderline.

import { connect, section, summary } from '../utils.mjs';

export async function run({ closeBrowser = true } = {}) {
  const { browser, page } = await connect();
  section('reCAPTCHA v3 score');

  // reCAPTCHA v3 scores CDP traffic as bot-like (per CloakBrowser docs), so we
  // deliberately minimize CDP here: NO humanize() (its mouse/scroll spam is
  // dozens of CDP calls), and a Node-side sleep instead of page.waitForTimeout
  // (which sends CDP commands). The single page.evaluate below is the only read.
  // NOTE: the truest score comes from driving this page by hand in the live
  // view with no CDP client attached — that's this image's real (human) use.
  // Google's OFFICIAL reCAPTCHA v3 demo — scores automatically on load with REAL
  // server-side verification. This is the method CloakBrowser's own example uses,
  // and unlike antcpt (a farming key with no real backend) the number is meaningful.
  await page.goto('https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The score renders only after an async token + backend-verify round-trip.
  await page.waitForFunction(
    "() => document.body.innerText.includes('Received response from our backend')",
    { timeout: 20000 }
  ).catch(() => {});
  const data = await page.evaluate(() => {
    const m = document.body.innerText.match(/"score":\s*([0-9.]+)/);
    return { score: m ? m[1] : null, raw: [] };
  });

  console.log('parsed score:', data.score);
  console.log('possible numeric candidates on page:', data.raw);

  const score = parseFloat(data.score);
  const ok = !isNaN(score) && score >= 0.7;
  // A low score here is expected: attaching over CDP at all depresses reCAPTCHA
  // v3 (per CloakBrowser docs), so anything under 0.7 is a WARN, not a hard fail
  // — the real score is what a human gets in the live view with no CDP attached.
  const warn = !isNaN(score) && score < 0.7;

  if (closeBrowser) await browser.close();
  return [{
    name: 'reCAPTCHA v3',
    pass: ok,
    warn,
    detail: isNaN(score)
      ? '(score not parsed)'
      : `score=${score}${ok ? '' : ' — CDP-depressed; verify in live view'}`,
  }];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
