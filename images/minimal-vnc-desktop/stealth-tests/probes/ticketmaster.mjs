// Ticketmaster reachability — does a human-driven Fortress session get served
// the real page, or an anti-bot interstitial?
//
// Unlike the vendor probes (turnstile/recaptcha) there is no scoring endpoint
// here: Ticketmaster is a live sensored property, so the only verdict we get
// is "the page rendered" vs "we got interrupted". The probe therefore
// classifies by observation and *reports* whichever anti-bot cookies are
// present rather than assuming a vendor — TM has moved between PerimeterX
// (_px*) and Imperva over time, and the cookie set is how we find out which
// stack a given edge/geo is serving us today.
//
// Two targets, because scrutiny is not uniform: the homepage is cheap to
// serve and rarely challenged, while a discovery/search page hits the
// backend API and is where a bad fingerprint or a flagged IP surfaces.
//
// Expect this to be IP-reputation dominated, like the ANA case in `akamai`.
// A FAIL through a datacenter/shared-proxy egress is not evidence of a
// fingerprint regression; re-run on a clean residential exit before treating
// it as one.

import { connect, humanize, section, summary } from '../utils.mjs';

const TARGETS = [
  { name: 'homepage',  url: 'https://www.ticketmaster.com/',                 host: 'https://www.ticketmaster.com/' },
  { name: 'discovery', url: 'https://www.ticketmaster.com/discover/concerts', host: 'https://www.ticketmaster.com/' },
];

// Interstitial copy across the stacks TM has used. Matched case-insensitively
// against the rendered body text.
const BLOCK_MARKERS = [
  'pardon the interruption',
  'your browsing activity has been paused',
  'access denied',
  'incapsula incident id',
  'request unsuccessful',
  'verify you are a human',
  'are you a robot',
];

// Cookies worth reporting, whichever stack answers. _px3 present = PerimeterX
// issued a real token (good); _pxhd alone usually means we never got that far.
const ANTIBOT_COOKIES = ['_px3', '_pxvid', '_pxhd', '_pxde', 'incap_ses', 'visid_incap', 'datadome', '_abck'];

export async function run({ closeBrowser = true, proxyAuth = false } = {}) {
  const { browser, ctx, page } = await connect({ proxyAuth });
  section('Ticketmaster anti-bot interstitial');

  const rows = [];
  for (const t of TARGETS) {
    let status = 0;
    try {
      const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = resp?.status() ?? 0;
    } catch (e) {
      console.log(`${t.name}: nav err ${e.message}`);
    }
    await humanize(page);

    const probe = await page.evaluate(() => ({
      title: document.title || '',
      text: (document.body?.innerText || '').slice(0, 20000),
      len: (document.body?.innerText || '').length,
      pxCaptcha: !!document.querySelector('#px-captcha, [id^="px-captcha"]'),
    })).catch(() => ({ title: '', text: '', len: 0, pxCaptcha: false }));

    const hay = `${probe.title}\n${probe.text}`.toLowerCase();
    const hit = BLOCK_MARKERS.find(m => hay.includes(m));
    // A challenge can render with a 200, and the real page can carry a
    // soft-404, so status alone decides nothing — require both a clean
    // status and an absence of interstitial markers, plus enough text that
    // we know we're not looking at a stub.
    const blocked = !!hit || probe.pxCaptcha || status === 403 || status === 429;
    const ok = !blocked && status >= 200 && status < 400 && probe.len > 500;

    const cookies = await ctx.cookies(t.host);
    const seen = ANTIBOT_COOKIES.filter(n => cookies.some(c => c.name === n));

    console.log(`  ${t.name.padEnd(10)} http=${status}  text=${probe.len}  cookies=[${seen.join(',') || 'none'}]${hit ? `  marker="${hit}"` : ''}`);

    rows.push({
      name: `Ticketmaster ${t.name}`,
      pass: ok,
      detail: blocked
        ? `blocked (http ${status}${hit ? `, "${hit}"` : ''}${probe.pxCaptcha ? ', px-captcha' : ''})`
        : ok
          ? `served (http ${status}, ${probe.len} chars)${seen.length ? `, cookies ${seen.join('/')}` : ''}`
          : `inconclusive (http ${status}, ${probe.len} chars)`,
    });
  }

  if (closeBrowser) await browser.close();
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run({ proxyAuth: process.env.PROXY_AUTH === '1' });
  summary(rows);
}
