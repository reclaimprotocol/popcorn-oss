// Dump the window/screen geometry a fresh popcorn staging pod presents.
//
// Why: with CDP detached the Ticketmaster homepage loads, but the sign-in flow
// still blocks. auth.ticketmaster.com scores harder than the homepage, so the
// question is which client-side signal fails there.
//
// A prime suspect is the chromeless kiosk window (402d646, "viewport-matched
// outer size"). Real Chrome ALWAYS has browser chrome: outerHeight exceeds
// innerHeight by roughly 80-100px (tabstrip + omnibox), and the window is
// smaller than the screen. A kiosk window where outerHeight === innerHeight,
// or where innerHeight === screen.height, is a combination no consumer browser
// produces — and window geometry is cheap for a bot classifier to read.
//
// This attaches over CDP purely to MEASURE. Contaminating the session does not
// matter here: we want the numbers, not a pass/fail verdict.
//
// Usage:
//   POPCORN_STAGING_CLIENT_ID=... POPCORN_STAGING_CLIENT_SECRET=... \
//   node pod-window-metrics.mjs

import { chromium } from 'playwright-core';

const CP = process.env.POPCORN_STAGING_CP_URL
  || 'https://popcorn-cp-gcp-asia-south1-stg.reclaimprotocol.org';
const CLIENT_ID = process.env.POPCORN_STAGING_CLIENT_ID || process.env.POPCORN_CLIENT_ID;
const CLIENT_SECRET = process.env.POPCORN_STAGING_CLIENT_SECRET || process.env.POPCORN_CLIENT_SECRET;
const sessionId = String(process.env.SESSION_ID || Date.now());
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${CLIENT_ID}:${CLIENT_SECRET}` };
const toWs = (u) => u.replace(/^(https?|wss?):\/\//, 'wss://');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set POPCORN_STAGING_CLIENT_ID / POPCORN_STAGING_CLIENT_SECRET.');
  process.exit(1);
}

let browser;
try {
  const res = await fetch(`${CP}/v1/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ sessionId, regions: ['asia-south1'] }),
  });
  if (!res.ok) throw new Error(`create session: ${res.status} ${await res.text()}`);
  const s = await res.json();
  console.log(`[pod] ${s.browserPodId ?? 'n/a'} region=${s.region ?? 'asia-south1'}`);

  browser = await chromium.connectOverCDP(toWs(s.cdpInternalUrl), { timeout: 60000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  // A real page, not about:blank — window metrics on about:blank can differ.
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  const m = await page.evaluate(() => {
    const readWebGL = (contextType) => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext(contextType);
      if (!gl) return { available: false };

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        available: true,
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : null,
        unmaskedRenderer: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : null,
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      };
    };

    return {
      inner: [window.innerWidth, window.innerHeight],
      outer: [window.outerWidth, window.outerHeight],
      screen: [screen.width, screen.height],
      avail: [screen.availWidth, screen.availHeight],
      screenPos: [window.screenX, window.screenY],
      dpr: window.devicePixelRatio,
      colorDepth: screen.colorDepth,
      webdriver: navigator.webdriver,
      ua: navigator.userAgent,
      platform: navigator.platform,
      hw: navigator.hardwareConcurrency,
      mem: navigator.deviceMemory,
      langs: navigator.languages,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webgl: readWebGL('webgl'),
      webgl2: readWebGL('webgl2'),
    };
  });

  const chromeH = m.outer[1] - m.inner[1];
  const chromeW = m.outer[0] - m.inner[0];

  console.log('\n===== POD WINDOW METRICS =====');
  console.log('inner       :', m.inner.join(' x '));
  console.log('outer       :', m.outer.join(' x '));
  console.log('screen      :', m.screen.join(' x '));
  console.log('avail       :', m.avail.join(' x '));
  console.log('screenX/Y   :', m.screenPos.join(', '));
  console.log('dpr / depth :', m.dpr, '/', m.colorDepth);
  console.log('webdriver   :', m.webdriver);
  console.log('platform    :', m.platform, '| hw', m.hw, '| mem', m.mem);
  console.log('languages   :', m.langs.join(','), '| tz', m.tz);
  console.log('ua          :', m.ua);
  console.log('--- graphics ---');
  for (const [name, gl] of [['webgl', m.webgl], ['webgl2', m.webgl2]]) {
    if (!gl.available) {
      console.log(`${name.padEnd(12)}: unavailable`);
      continue;
    }
    console.log(`${name.padEnd(12)}: ${gl.vendor} | ${gl.renderer}`);
    console.log(`${`${name} actual`.padEnd(12)}: ${gl.unmaskedVendor ?? 'hidden'} | ${gl.unmaskedRenderer ?? 'hidden'}`);
    console.log(`${`${name} version`.padEnd(12)}: ${gl.version} | ${gl.shadingLanguageVersion}`);
  }
  console.log('--- derived ---');
  console.log(`chrome height: ${chromeH}px  ${chromeH === 0 ? '<-- NO BROWSER CHROME (real Chrome is ~80-100px)' : ''}`);
  console.log(`chrome width : ${chromeW}px`);
  if (m.inner[1] === m.screen[1]) console.log('innerHeight === screen.height  <-- viewport fills the whole screen, no OS chrome either');
  if (m.outer[1] === m.screen[1]) console.log('outerHeight === screen.height  <-- window is exactly the screen');
  if (m.screenPos[0] === 0 && m.screenPos[1] === 0) console.log('window at 0,0            <-- plausible for kiosk, unusual for a user-dragged window');
  const graphicsIdentity = [m.webgl, m.webgl2]
    .flatMap((gl) => [gl.vendor, gl.renderer, gl.unmaskedVendor, gl.unmaskedRenderer])
    .filter(Boolean)
    .join(' ');
  if (/swiftshader|llvmpipe|software rasterizer/i.test(graphicsIdentity)) {
    console.log('software WebGL renderer detected  <-- strong container/VM environment signal');
  }
  console.log('==============================\n');
} catch (e) {
  console.error('[fatal]', e.message);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch {}
  await fetch(`${CP}/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers }).catch(() => {});
  console.log('[cleanup] session deleted');
}
