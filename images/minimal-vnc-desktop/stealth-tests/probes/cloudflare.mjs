// Cloudflare bot detection probe.
//
// We test against real CF-protected sites that DON'T force a challenge as
// a demo. The signal we care about is "did CF serve me the real page or
// did it bounce me to the 'Just a moment…' managed challenge?".
//
// Demo sites like nopecha.com/demo/cloudflare are useless here — they
// configure CF to challenge everyone regardless of fingerprint. We use
// chat.openai.com (CF Bot Management with high difficulty turned on) and
// discord.com (CF Bot Fight Mode) as load-bearing targets, plus a third
// generic CF property as cross-validation.

import { connect, humanize, section, summary } from '../utils.mjs';

const TARGETS = [
  // CF Bot Management, known-aggressive
  { name: 'chat.openai.com',   url: 'https://chat.openai.com/' },
  // CF Bot Fight Mode, moderate
  { name: 'discord.com',       url: 'https://discord.com/' },
  // CF homepage itself, baseline
  { name: 'cloudflare.com',    url: 'https://www.cloudflare.com/' },
];

// Patterns that ONLY appear when CF served us the managed-challenge
// interstitial. We deliberately do NOT match "cf-turnstile-iframe" or
// "cf-mitigated" headers — Turnstile widgets can legitimately appear on
// login forms of properties that otherwise served us the real page, and
// cf-mitigated is set for any CF rule that fired, not just challenges.
const CHALLENGE_PATTERNS = [
  /<title>\s*just a moment\.\.\.\s*<\/title>/i,
  /checking if the site connection is secure/i,
  /<form[^>]+id=["']challenge-form["']/i,
  /cf_chl_opt/i,
];

export async function run({ closeBrowser = true } = {}) {
  const { browser, page } = await connect();
  section('Cloudflare bot detection');

  const rows = [];
  for (const t of TARGETS) {
    let challenged = null, cfRay = null, status = null, title = '';
    try {
      const r = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = r?.status() ?? null;
      cfRay = r?.headers()['cf-ray'] || null;
      await humanize(page, { rounds: 2, dwell: 1000 });
      await page.waitForTimeout(3000);
      title = await page.title().catch(()=>'');
      const html = await page.content();
      challenged = CHALLENGE_PATTERNS.some(re => re.test(html));
    } catch (e) {
      console.log(`  ${t.name} nav err: ${e.message}`);
      challenged = null; // unknown
    }
    console.log(`  ${t.name.padEnd(20)} status=${status}  cf-ray=${cfRay ? 'yes' : 'no'}  challenged=${challenged}  title="${title.slice(0,40)}"`);
    rows.push({
      name: `CF ${t.name}`,
      pass: challenged === false,
      warn: challenged === null,
      detail: challenged === false ? 'served real page' : challenged === true ? 'hit managed-challenge' : 'nav error',
    });
  }

  if (closeBrowser) await browser.close();
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
