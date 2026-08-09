import { connect } from '../utils.mjs';

export async function run() {
  const { browser, page } = await connect();
  await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(30000); // trust gauge loads late from backend
  const data = await page.evaluate(() => {
    // Lie reasons live in title attributes across the doc.
    const titled = Array.from(document.querySelectorAll('[title]'))
      .map((e) => ({ title: e.getAttribute('title'), cls: e.className, tag: e.tagName, txt: (e.textContent||'').trim().slice(0,40) }))
      .filter((e) => e.title && e.title.length > 3);

    // Rejected sections + their descriptive lie children.
    const rejected = Array.from(document.querySelectorAll('.rejected')).map((e) => {
      const heading = (e.querySelector('strong,.pointer,span')?.textContent || e.textContent).trim().slice(0,30);
      const liesChild = Array.from(e.querySelectorAll('.lies')).map(x => ({ txt: x.textContent.trim(), title: x.getAttribute('title') }));
      return { heading, className: e.className, lies: liesChild, title: e.getAttribute('title') };
    });

    // Trust score: find standalone percentage text and any "trust" mention.
    const trustCandidates = Array.from(document.querySelectorAll('*'))
      .filter((e) => e.children.length === 0)
      .map((e) => (e.textContent||'').trim())
      .filter((t) => /trust|^\d{1,3}(\.\d+)?%$|bot|blink|grade/i.test(t) && t.length < 60);

    return { titled, rejected, trustCandidates: [...new Set(trustCandidates)] };
  });
  console.log('=== REJECTED SECTIONS (lies) ===');
  console.log(JSON.stringify(data.rejected, null, 2));
  console.log('\n=== TITLE ATTRS (lie reasons) ===');
  data.titled.forEach((t) => console.log(`{${t.tag}.${t.cls}} "${t.txt}" => TITLE: ${t.title}`));
  console.log('\n=== TRUST / GRADE CANDIDATES ===');
  data.trustCandidates.forEach((t) => console.log(' -', t));
  return [];
}

if (import.meta.url === `file://${process.argv[1]}`) { await run(); process.exit(0); }
