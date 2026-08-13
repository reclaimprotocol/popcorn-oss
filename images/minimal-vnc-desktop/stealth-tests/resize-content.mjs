// resize-content: sample ACTUAL canvas pixels to find the painted extent of the
// framebuffer, so we can tell real content-black (kiosk window doesn't cover the
// framebuffer) from mere geometric letterbox. Throwaway only (6081/9227).
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const CTR = process.env.CTR || 'pcn-fixtest';
const VIEWER = process.env.VIEWER || 'http://localhost:6081/liveview.html';
const EXTRA = process.env.EXTRA || '';
const sh = (c) => { try { return execSync(c).toString().trim(); } catch { return '(err)'; } };
const fb = () => sh(`docker exec ${CTR} sh -lc 'DISPLAY=:1 xrandr 2>/dev/null | grep -i current'`).replace(/^Screen 0:.*current /, '').replace(/,.*/, '');
const kioskWin = () => { const t = sh(`docker exec ${CTR} sh -lc 'DISPLAY=:1 xwininfo -root -tree 2>/dev/null | grep -iE "chromium-browser" | head -1'`); const m = t.match(/(\d+x\d+\+[\-\d]+\+[\-\d]+)/); return m ? m[1] : t.slice(0,50); };

// Sample the canvas BACKING buffer on a grid; classify each cell as background
// (#111/#000, i.e. unpainted X root or noVNC bg) vs content. Report painted extent.
async function sampleContent(p) {
  return await p.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c || !c.width) return { err: 'no-canvas' };
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const W = c.width, H = c.height;
    const isBg = (d) => (Math.abs(d[0]-17)<10 && Math.abs(d[1]-17)<10 && Math.abs(d[2]-17)<10) // #111 noVNC bg
                     || (d[0]<10 && d[1]<10 && d[2]<10); // pure black X root
    const N = 40; // grid
    let maxContentX = 0, maxContentY = 0;
    const colHasContent = new Array(N).fill(false), rowHasContent = new Array(N).fill(false);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = Math.min(W-1, Math.floor((i+0.5)*W/N)), y = Math.min(H-1, Math.floor((j+0.5)*H/N));
      let d; try { d = ctx.getImageData(x, y, 1, 1).data; } catch { return { err: 'read-blocked' }; }
      if (!isBg(d)) { colHasContent[i] = true; rowHasContent[j] = true; if (x>maxContentX) maxContentX=x; if (y>maxContentY) maxContentY=y; }
    }
    // rightmost / bottommost grid cell WITH content (approx painted extent)
    let lastCol = -1, lastRow = -1;
    for (let i = 0; i < N; i++) if (colHasContent[i]) lastCol = i;
    for (let j = 0; j < N; j++) if (rowHasContent[j]) lastRow = j;
    const paintedW = lastCol >= 0 ? Math.round((lastCol+1)*W/N) : 0;
    const paintedH = lastRow >= 0 ? Math.round((lastRow+1)*H/N) : 0;
    return { W, H, paintedW, paintedH, blackRightPx: W - paintedW, blackBottomPx: H - paintedH };
  }).catch(e => ({ err: e.message }));
}

async function step(p, w, h, label, wait = 3500) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(wait);
  const s = await sampleContent(p);
  if (s.err) { console.log(`[${label}] win=${w}x${h} fb=${fb()} kiosk=${kioskWin()}  SAMPLE ERR: ${s.err}`); return; }
  const verdict = (s.blackRightPx > 40 || s.blackBottomPx > 40) ? '  <-- CONTENT BLACK' : '';
  console.log(`[${label}] win=${w}x${h} fb=${fb()} kiosk=${kioskWin()}  backing=${s.W}x${s.H} paintedContent=${s.paintedW}x${s.paintedH} blackR=${s.blackRightPx}px blackB=${s.blackBottomPx}px${verdict}`);
}

const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });
const p = await ctx.newPage();
await p.goto(`${VIEWER}?magnify=1&resize=scale&reconnect=1${EXTRA}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await p.waitForTimeout(12000);
await step(p, 390, 844,  'settle-phone');
await step(p, 900, 900,  'GROW 900x900');
await step(p, 1440, 900, 'GROW 1440x900');
await step(p, 2200, 1200,'GROW 2200x1200 (past kiosk 1919x1079)');
await step(p, 1200, 900, 'SHRINK 1200x900');
await b.close();
