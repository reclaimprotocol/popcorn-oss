// bot.sannysoft.com — a curated grid of headless/automation tells. The
// page renders a table where each row is a check (webdriver, plugins,
// languages, chrome obj, permissions, iframe content window, etc.) and
// colors the cell green (pass) or red (fail).
//
// We scrape the table and count fails. Anything >0 fails is a real signal
// to fix in CloakBrowser.

import { connect, humanize, section, summary } from '../utils.mjs';

export async function run({ closeBrowser = true } = {}) {
  const { browser, page } = await connect();
  section('bot.sannysoft.com automation checks');

  await page.goto('https://bot.sannysoft.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanize(page, { rounds: 2, dwell: 1000 });
  // sannysoft runs all checks at load; give async ones a beat
  await page.waitForTimeout(5000);

  // The page renders one table per check group. Cells with class "passed"
  // or "failed" are colorized; we count both.
  const data = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    const out = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) continue;
      const name = cells[0].innerText.trim();
      const result = cells[1].innerText.trim();
      const cls = (cells[1].className || '').toLowerCase();
      out.push({ name, result, cls });
    }
    return out;
  });

  // sannysoft colorizes via cell class only: "passed" (green) or "failed"
  // (red). The text content can read "missing" or "present" depending on
  // the check — sometimes "missing" IS the pass state (e.g. webdriver
  // missing is good). So we read the class, not the text.
  let fails = 0, passes = 0;
  for (const r of data) {
    const cls = (r.cls || '').toLowerCase();
    let verdict;
    if (cls.includes('failed') || cls.includes('result-failed')) verdict = 'fail';
    else if (cls.includes('passed') || cls.includes('result-passed')) verdict = 'pass';
    else verdict = null; // unclassified rows (table headers, separators)
    if (verdict === 'fail') { fails++; console.log(`  ✗ ${r.name.padEnd(45)} ${r.result}`); }
    else if (verdict === 'pass') passes++;
  }
  console.log(`\n  passed: ${passes}   failed: ${fails}`);

  if (closeBrowser) await browser.close();
  return [{
    name: 'sannysoft fails',
    pass: fails === 0,
    warn: fails > 0 && fails <= 2,
    detail: `${fails} failures out of ${passes + fails}`,
  }];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
