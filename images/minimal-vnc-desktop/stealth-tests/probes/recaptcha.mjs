// reCAPTCHA v3 score probe.
//
// v3 is silent: the meaningful score is returned by the site's backend after it
// verifies the browser token with Google. Use Google's official demo and read
// that backend JSON response directly; scraping the rendered text is only a
// fallback because the page markup changes more often than the verify endpoint.

import { connect, section, summary } from '../utils.mjs';

const DEMO_URL = 'https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php';
const VERIFY_RE = /\/recaptcha-v3-verify\.php\?/;
const ATTEMPTS = Number(process.env.RECAPTCHA_ATTEMPTS || 2);

function parseScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

async function readDomScore(page) {
  return page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    const jsonMatch = text.match(/"score"\s*:\s*([0-9.]+)/);
    if (jsonMatch) return { score: jsonMatch[1], source: 'dom-json' };
    const loose = text.match(/\bscore\b[^0-9]{0,40}([01](?:\.\d+)?)/i);
    return { score: loose ? loose[1] : null, source: 'dom-text' };
  }).catch(() => ({ score: null, source: 'dom-error' }));
}

export async function run({ closeBrowser = true } = {}) {
  const { browser, page } = await connect();
  section('reCAPTCHA v3 score');

  // reCAPTCHA v3 scores CDP traffic as bot-like (per CloakBrowser docs), so we
  // deliberately minimize CDP here: NO humanize() (its mouse/scroll spam is
  // dozens of CDP calls), and a Node-side sleep instead of page.waitForTimeout
  // (which sends CDP commands). The single page.evaluate below is the only read.
  // NOTE: the truest score comes from driving this page by hand in the live
  // view with no CDP client attached — that's this image's real (human) use.
  let result = { score: null, source: 'none', detail: '' };
  for (let i = 1; i <= Math.max(1, ATTEMPTS); i++) {
    const verify = page.waitForResponse(
      (r) => VERIFY_RE.test(r.url()) && r.status() === 200,
      { timeout: 30000 }
    ).then(async (r) => {
      const json = await r.json();
      return {
        score: parseScore(json.score),
        source: 'backend-json',
        detail: `success=${json.success} action=${json.action || 'n/a'}`,
      };
    }).catch((e) => ({ score: null, source: 'backend-timeout', detail: e.message }));

    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result = await verify;
    if (result.score !== null) break;

    const dom = await readDomScore(page);
    result = {
      score: parseScore(dom.score),
      source: dom.source,
      detail: result.detail,
    };
    if (result.score !== null) break;
  }

  console.log('parsed score:', result.score);
  console.log('score source:', result.source, result.detail);

  const score = result.score;
  const ok = !isNaN(score) && score >= 0.7;
  // A low score here is expected: attaching over CDP at all depresses reCAPTCHA
  // v3 (per CloakBrowser docs), so anything under 0.7 is a WARN, not a hard fail
  // — the real score is what a human gets in the live view with no CDP attached.
  const warn = score === null || score < 0.7;

  if (closeBrowser) await browser.close();
  return [{
    name: 'reCAPTCHA v3',
    pass: ok,
    warn,
    detail: score === null
      ? `(score unavailable via ${result.source})`
      : `score=${score} via ${result.source}${ok ? '' : ' — CDP/reputation sensitive'}`,
  }];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
