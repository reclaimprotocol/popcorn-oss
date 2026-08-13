// Measure liveview fit geometry + black-band regions across scenarios.
// Reusable for before/after a fix. Reports, per scenario: live X framebuffer,
// RFB canvas backing size, canvas rect, computed transform, remote page
// screen/inner/dpr, and a screenshot scan for black bands (top/bottom/left/right).
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const CDP = 'http://127.0.0.1:9226';
const VIEWER = 'http://localhost:6080/liveview.html';

const xrandr = () => {
  try { return execSync(`docker exec minimal-vnc-desktop sh -lc 'DISPLAY=:1 xrandr 2>/dev/null | grep -i current'`).toString().trim().replace(/^Screen 0:.*current /, '').replace(/,.*/, ''); }
  catch { return '(xrandr failed)'; }
};

// scan a screenshot buffer (PNG via sharp-free: use page.evaluate on a canvas) — instead,
// we scan by sampling the VIEWER's rendered pixels through a screenshot + jimp-free approach:
// simplest is to read the canvas pixels in the REMOTE isn't possible; so we scan the viewer
// screenshot with a tiny PNG decoder via page.evaluate drawing the screenshot is overkill.
// Instead: measure black bands geometrically from canvas rect vs window.

async function scenario({ label, w, h, dsf, mobile, magnify }) {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, hasTouch: !!mobile, isMobile: !!mobile });
  const p = await ctx.newPage();
  const url = `${VIEWER}?resize=scale&reconnect=1${magnify ? '&magnify=1' : ''}`;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(magnify ? 11000 : 9000); // let magnify settle() fire
  const fb = xrandr();
  const view = await p.evaluate(() => {
    const c = document.querySelector('canvas');
    const s = document.querySelector('#screen') || (c && c.parentElement);
    const r = c ? c.getBoundingClientRect() : null;
    const cs = c ? getComputedStyle(c) : null;
    const ss = s ? getComputedStyle(s) : null;
    return {
      canvasBacking: c ? `${c.width}x${c.height}` : 'no-canvas',
      canvasRect: r ? `x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}` : 'n/a',
      canvasTransform: cs ? cs.transform : '',
      screenTransform: ss ? `${ss.transform} origin=${ss.transformOrigin}` : '',
      win: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
      // letterbox estimate: gap between canvas rect and window
      blackTop: r ? Math.round(r.y) : 0,
      blackLeft: r ? Math.round(r.x) : 0,
      blackRight: r ? Math.round(window.innerWidth - (r.x + r.width)) : 0,
      blackBottom: r ? Math.round(window.innerHeight - (r.y + r.height)) : 0,
    };
  }).catch(e => ({ err: e.message }));

  // remote page facts over CDP
  let remote = {};
  try {
    const rb = await chromium.connectOverCDP(CDP, { timeout: 12000 });
    const rp = rb.contexts()[0].pages()[0];
    remote = await rp.evaluate(() => ({
      screen: `${screen.width}x${screen.height}`, inner: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio,
    }));
    await rb.close();
  } catch (e) { remote = { err: e.message.split('\n')[0].slice(0, 50) }; }

  await b.close();
  return { label, params: `${w}x${h} dsf=${dsf} mobile=${!!mobile} magnify=${!!magnify}`, fb, view, remote };
}

const scenarios = [
  { label: 'kindle-default', w: 800, h: 1280, dsf: 1, mobile: true, magnify: false },
  { label: 'kindle-magnify', w: 800, h: 1280, dsf: 1, mobile: true, magnify: true },
  { label: 'desktop-zoom50-remoteResize', w: 3456, h: 1732, dsf: 0.5, mobile: false, magnify: true },
  { label: 'desktop-normal', w: 1728, h: 866, dsf: 1, mobile: false, magnify: true },
];

for (const s of scenarios) {
  const r = await scenario(s);
  console.log(`\n### ${r.label}  [${r.params}]`);
  console.log(`  X framebuffer : ${r.fb}`);
  console.log(`  canvas backing: ${r.view.canvasBacking}   rect: ${r.view.canvasRect}`);
  console.log(`  screen xform  : ${r.view.screenTransform}`);
  console.log(`  viewer win/dpr: ${r.view.win} dpr=${r.view.dpr}`);
  console.log(`  black bands   : top=${r.view.blackTop} bottom=${r.view.blackBottom} left=${r.view.blackLeft} right=${r.view.blackRight}`);
  console.log(`  remote page   : screen=${r.remote.screen} inner=${r.remote.inner} dpr=${r.remote.dpr}${r.remote.err ? ' ERR:' + r.remote.err : ''}`);
}
