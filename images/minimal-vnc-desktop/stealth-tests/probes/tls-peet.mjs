// TLS / HTTP-2 fingerprint via tls.peet.ws.
//
// Pass criteria: ja4 starts with "t13d1516h2_8daaf6152771_" (canonical
// Chrome on Windows/Linux 13x). Akamai H2 fingerprint hash should match a
// recent real-Chrome reference; we don't hardcode the hash because it
// drifts across chrome versions, but log it for human inspection.

import { connect, section, summary } from '../utils.mjs';

// Match by cipher-list hash, not exact extension count. JA4's second-
// segment-third-field is the SHA-256(cipher list)[:12]; real Chrome's is
// "8daaf6152771". The extension count digits (e.g. 1516 vs 1517) drift
// with chrome flags (fake-media-device adds an extension), so we only
// pin on the cipher hash which is the structural Chrome tell.
const CHROME_JA4_CIPHER_HASH = '_8daaf6152771_';

export async function run({ closeBrowser = true } = {}) {
  const { browser, page } = await connect();
  section('TLS / HTTP-2 fingerprint  (tls.peet.ws)');

  await page.goto('https://tls.peet.ws/api/all', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const text = await page.evaluate(() => document.body.innerText);
  let data;
  try { data = JSON.parse(text); } catch { console.log('not JSON:', text.slice(0,400)); throw new Error('peet.ws returned non-JSON'); }

  const tls = data.tls || {}, h2 = data.http2 || {};
  const ja4 = tls.ja4 || '';
  const ok = ja4.includes(CHROME_JA4_CIPHER_HASH);

  console.log('ip:', data.ip);
  console.log('user_agent:', data.user_agent);
  console.log('http_version:', data.http_version);
  console.log('ja3_hash:', tls.ja3_hash);
  console.log('ja4:', ja4);
  console.log('peetprint_hash:', tls.peetprint_hash);
  console.log('akamai_fingerprint:', h2.akamai_fingerprint);
  console.log('akamai_fingerprint_hash:', h2.akamai_fingerprint_hash);

  if (closeBrowser) await browser.close();
  return [{
    name: 'TLS JA4',
    pass: ok,
    detail: ok ? `Chrome-canonical (${ja4})` : `unexpected: ${ja4}`,
  }];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
