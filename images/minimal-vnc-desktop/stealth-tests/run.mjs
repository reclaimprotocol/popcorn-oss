// Stealth-suite orchestrator. Runs every probe in sequence against the
// running container's chromium (via CDP at $CDP_URL, default
// http://127.0.0.1:9223) and prints a single combined summary at the end.
//
// Usage:
//   # default: run all probes
//   node stealth-tests/run.mjs
//
//   # subset: run only listed probes
//   node stealth-tests/run.mjs tls akamai
//
//   # with brightdata proxy auth (creds at /tmp/proxy-creds.json)
//   PROXY_AUTH=1 node stealth-tests/run.mjs
//
//   # custom CDP endpoint (e.g. running on different host)
//   CDP_URL=http://10.0.0.5:9223 node stealth-tests/run.mjs
//
// Each probe attaches to the same chromium instance, reuses its existing
// page, and closes its own browser handle at the end (the underlying
// chromium keeps running — connectOverCDP only closes the playwright
// wrapper). So probes run sequentially without restarting the browser.

import { summary } from './utils.mjs';

const PROBES = {
  tls:         () => import('./probes/tls-peet.mjs'),
  akamai:      () => import('./probes/akamai.mjs'),
  creepjs:     () => import('./probes/creepjs.mjs'),
  sannysoft:   () => import('./probes/sannysoft.mjs'),
  cloudflare:  () => import('./probes/cloudflare.mjs'),
  turnstile:   () => import('./probes/turnstile.mjs'),
  recaptcha:   () => import('./probes/recaptcha.mjs'),
  browserscan: () => import('./probes/browserscan.mjs'),
};

const args = process.argv.slice(2);
const wanted = args.length ? args : Object.keys(PROBES);
const proxyAuth = process.env.PROXY_AUTH === '1';

const rows = [];
const errors = [];
for (const name of wanted) {
  if (!PROBES[name]) {
    console.warn(`unknown probe: ${name}  (available: ${Object.keys(PROBES).join(', ')})`);
    continue;
  }
  try {
    const mod = await PROBES[name]();
    const r = await mod.run({ proxyAuth });
    rows.push(...r);
  } catch (e) {
    console.error(`\n!! ${name} threw: ${e.message}`);
    errors.push(name);
    rows.push({ name, pass: false, detail: `error: ${e.message}` });
  }
}

summary(rows);
if (errors.length) {
  console.log(`probes with errors: ${errors.join(', ')}`);
  process.exit(2);
}
const failed = rows.filter(r => !r.pass && !r.warn).length;
process.exit(failed > 0 ? 1 : 0);
