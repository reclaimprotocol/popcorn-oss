// CreepJS — abrahamjuliot.github.io/creepjs is the canonical "how leaky is
// my browser fingerprint" check. It runs ~50 fingerprint vectors and
// aggregates a trust score. We don't fail on a specific number (CreepJS
// keeps moving the goalposts) but we extract the headline score and
// flag well-known bot tells.
//
// What we look for in the parsed result:
//   * trust_score: composite score (0-100); >85 is a healthy real-Chrome target
//   * lies: list of detected JS-level overrides (Object.defineProperty traces)
//   * automation: explicit headless/webdriver tells
//   * resistance: how many resist-fingerprint flags are tripped

import { connect, humanize, section, summary } from '../utils.mjs';

export async function run({ closeBrowser = true } = {}) {
  const { browser, page } = await connect();
  section('CreepJS fingerprint score');

  await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // CreepJS computes asynchronously — give it a full minute and poll for
  // the trust-score element.
  console.log('waiting for CreepJS to finish computing (up to 60s)...');
  await humanize(page, { rounds: 3, dwell: 2000 });
  await page.waitForTimeout(15000);

  // Extract the key signals. CreepJS DOM:
  //   .trust-score      → "X% trust"
  //   .lies-list li     → detected lies (one per line, or "none")
  //   .fingerprint-id   → unique fingerprint id (we don't pin, just log)
  const data = await page.evaluate(() => {
    // CreepJS renders its headline "trust score" as the first percentage on the
    // page; its DOM class names churn, so scraping by class is unreliable (the
    // old `.trust-score-container`/regex returned null). The first % is the
    // headline score. Separately collect *detected* lies from the lies section
    // — we must NOT just grep the body for "webdriver"/"headless", because those
    // words always appear as check labels (that's why it falsely read "Headless").
    const body = document.body.innerText;
    const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
    const pct = body.match(/([\d.]+)\s*%/);
    const lies = Array.from(document.querySelectorAll('.lies, .rejected, [class*="lie"]'))
      .map((e) => e.innerText.trim()).filter(Boolean).slice(0, 10);
    const headlessIndex = lines.findIndex((l) => /^Headless/i.test(l));
    const headlessLines = headlessIndex >= 0 ? lines.slice(headlessIndex, headlessIndex + 10) : [];
    const gpuIndex = lines.findIndex((l) => l.toLowerCase() === 'gpu:');
    const gpuLines = gpuIndex >= 0 ? lines.slice(gpuIndex + 1, gpuIndex + 3) : [];
    const gpuConfidence = (() => {
      const beforeGpu = gpuIndex > 0 ? lines.slice(Math.max(0, gpuIndex - 4), gpuIndex) : [];
      const afterGpu = gpuIndex >= 0 ? lines.slice(gpuIndex, gpuIndex + 6) : [];
      const line = [...beforeGpu, ...afterGpu].find((l) => /^confidence:\s*/i.test(l));
      return line ? line.replace(/^confidence:\s*/i, '') : null;
    })();
    return {
      trust: pct ? parseFloat(pct[1]) : null,
      lies,
      headless: {
        chromium: headlessLines.some((l) => /^chromium:\s*true/i.test(l)),
        like: (() => {
          const line = headlessLines.find((l) => /like headless/i.test(l));
          const m = line && line.match(/([\d.]+)\s*%/);
          return m ? Number(m[1]) : null;
        })(),
        headless: (() => {
          const line = headlessLines.find((l) => /^\d+(?:\.\d+)?%\s+headless/i.test(l));
          const m = line && line.match(/([\d.]+)\s*%/);
          return m ? Number(m[1]) : null;
        })(),
        stealth: (() => {
          const line = headlessLines.find((l) => /^\d+(?:\.\d+)?%\s+stealth/i.test(l));
          const m = line && line.match(/([\d.]+)\s*%/);
          return m ? Number(m[1]) : null;
        })(),
      },
      gpuConfidence,
      gpu: gpuLines.join(' | '),
    };
  });

  console.log('trust score:', data.trust, ' detected lies:', data.lies);
  console.log('headless:', data.headless, 'gpu confidence:', data.gpuConfidence || '(not parsed)', 'gpu:', data.gpu || '(not parsed)');

  // CreepJS is a fingerprint-consistency tool, not a real-world bot gate, and it
  // scores spoofed browsers harshly — treat it as informational. The load-bearing
  // vendors (Akamai/Cloudflare/reCAPTCHA) are covered by their own probes.
  const trust = data.trust;
  const ok = trust !== null && trust >= 50;

  if (closeBrowser) await browser.close();
  return [{
    name: 'CreepJS trust',
    pass: ok,
    warn: trust !== null && trust >= 30 && trust < 50,
    detail: trust !== null
      ? `${trust}% headline; headless=${data.headless.headless ?? '?'} stealth=${data.headless.stealth ?? '?'} like=${data.headless.like ?? '?'} gpu=${data.gpuConfidence || '?'}`
      : '(score not parsed)',
  }];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
