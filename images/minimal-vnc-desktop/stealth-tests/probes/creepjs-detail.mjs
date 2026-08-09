// Detailed CreepJS extractor — reloads twice and pulls the full detected-lies
// list, per-metric hashes+values (Canvas/DOMRect/Audio/SVG), GPU strings,
// headless/stealth/like flags, and the fonts list.
import { connect } from '../utils.mjs';

function grab() {
  const out = {};
  const bodyText = document.body.innerText;

  // ---- Detected lies -------------------------------------------------------
  // CreepJS renders a "lies (N)" section. Collect the whole lies block text.
  out.rawLiesEls = Array.from(document.querySelectorAll('[class*="lies"], .rejected, [class*="lie"]'))
    .map((e) => ({ cls: e.className, text: e.innerText.trim() }))
    .filter((e) => e.text);

  // ---- Fingerprint sections ------------------------------------------------
  // Each metric lives in a .col-* container; dump their innerText keyed by the
  // leading label.
  const cols = Array.from(document.querySelectorAll('.col-2, .col-3, .col-4, .col-6, .col-8, .col-12, [class^="col-"]'));
  out.cols = cols.map((c) => c.innerText.trim()).filter(Boolean);

  // Full body as a fallback for anything the selectors miss.
  out.bodyText = bodyText;

  // Fingerprint id / visitor id if present.
  out.title = document.title;
  return out;
}

export async function run({ closeBrowser = false } = {}) {
  const { browser, page } = await connect();
  const runs = [];
  for (let i = 0; i < 2; i++) {
    await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);
    const data = await page.evaluate(grab);
    runs.push(data);
    console.log(`\n================ RUN ${i + 1} ================`);
    console.log('--- LIES ELS ---');
    for (const l of data.rawLiesEls) console.log(`[${l.cls}]\n${l.text}\n`);
    console.log('--- COLS ---');
    data.cols.forEach((c, idx) => console.log(`### COL ${idx} ###\n${c}\n`));
    console.log('--- BODY (full) ---');
    console.log(data.bodyText);
  }
  if (closeBrowser) await browser.close();
  return runs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
