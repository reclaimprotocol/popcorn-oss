// Akamai BMP _abck verdict across a curated set of public sensored sites.
//
// PASS = "~0~" token after humanize. Mixed results are expected: Delta,
// Finnair, Hilton tend to pass with the current stealth surface; ANA stays
// "-1" because it weights IP rep aggressively against BrightData ranges
// (see images/chromium-headful/docs/AUTH-PATHS.md for why we don't fight
// per-property IP-rep blocks at the image level).

import { connect, humanize, readCookie, parseAbck, pass, section, summary } from '../utils.mjs';

const TARGETS = [
  { name: 'delta.com',   url: 'https://www.delta.com/',           host: 'https://www.delta.com/' },
  { name: 'finnair.com', url: 'https://www.finnair.com/in-en',    host: 'https://www.finnair.com/' },
  { name: 'hilton.com',  url: 'https://www.hilton.com/en/',       host: 'https://www.hilton.com/' },
  { name: 'ana.co.jp',   url: 'https://www.ana.co.jp/en/jp/',     host: 'https://www.ana.co.jp/' },
];

export async function run({ closeBrowser = true, proxyAuth = false } = {}) {
  const { browser, ctx, page } = await connect({ proxyAuth });
  section('Akamai BMP _abck verdict');

  const rows = [];
  for (const t of TARGETS) {
    try {
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) { console.log(`${t.name}: nav err ${e.message}`); }
    await humanize(page);
    const c = await readCookie(ctx, t.host, '_abck');
    const v = parseAbck(c);
    const ok = v && pass(v.token);
    console.log(`  ${t.name.padEnd(14)} _abck=${v?.token ?? '(none)'}  len=${v?.len ?? 0}`);
    rows.push({
      name: `Akamai ${t.name}`,
      pass: ok,
      detail: v ? `_abck token ~${v.token}~` : 'no _abck cookie',
    });
  }

  if (closeBrowser) await browser.close();
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run({ proxyAuth: process.env.PROXY_AUTH === '1' });
  summary(rows);
}
