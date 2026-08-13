// Verify window-follows-screen (proxy/window.go) + first-connect screen reset
// (screen.go) end to end against a LIVE container, with pixel-level evidence:
// for each scenario we assert the X screen vs Chromium-window geometry from
// inside the container AND scan an actual framebuffer screenshot (scrot) for
// black X-root rows — the band the fix exists to kill. Geometric letterbox in
// the viewer is legitimate; black pixels inside the framebuffer are not.
//
// Usage: node verify-window-follows-screen.mjs [container] [viewerPort]
//   defaults: mvd-verify 6081
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTAINER = process.argv[2] || 'mvd-verify';
const PORT = process.argv[3] || '6081';
const VIEWER = `http://localhost:${PORT}/liveview.html`;
const OUT = mkdtempSync(join(tmpdir(), 'band-verify-'));

// Route through sh: on a Rosetta-emulated amd64 container, `docker exec env
// DISPLAY=:1 xdotool` loses the variable at the exec boundary while a shell
// export inside the container works.
const dx = (cmd) => execSync(`docker exec ${CONTAINER} sh -c "export DISPLAY=:1; ${cmd}"`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function geometry() {
  const [sw, sh] = dx('xdotool getdisplaygeometry').split(/\s+/).map(Number);
  const ids = dx('xdotool search --onlyvisible --class chromium').split(/\s+/).filter(Boolean);
  const windows = ids.map((id) => {
    const kv = Object.fromEntries(dx(`xdotool getwindowgeometry --shell ${id}`).split(/\s+/).map((l) => l.split('=')));
    return { id, w: Number(kv.WIDTH), h: Number(kv.HEIGHT) };
  });
  return { sw, sh, windows };
}

function framebufferShot(name) {
  dx('scrot -o /tmp/band-verify.png');
  const local = join(OUT, `${name}.png`);
  execSync(`docker cp ${CONTAINER}:/tmp/band-verify.png ${local}`);
  return local;
}

// Count solid-black rows from the bottom of the screenshot (the X root is pure
// black; any real page bottom — even a dark-mode footer — has chrome scrollbar
// pixels and antialiasing that break the 97% threshold).
async function blackBottomRows(browser, pngPath) {
  const b64 = readFileSync(pngPath).toString('base64');
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const res = await p.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    let black = 0;
    for (let y = img.height - 1; y >= 0; y--) {
      const row = g.getImageData(0, y, img.width, 1).data;
      let dark = 0;
      for (let i = 0; i < row.length; i += 4) {
        if (row[i] < 16 && row[i + 1] < 16 && row[i + 2] < 16) dark++;
      }
      if (dark / img.width > 0.97) black++;
      else break;
    }
    return { w: img.width, h: img.height, black };
  }, b64);
  await ctx.close();
  return res;
}

const failures = [];
function check(label, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures.push(`${label}: ${detail}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function runViewer({ w, h, dsf = 1, mobile = false, magnify = false, extra = '', settleMs }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, hasTouch: mobile, isMobile: mobile });
  const p = await ctx.newPage();
  await p.goto(`${VIEWER}?resize=scale&reconnect=1${magnify ? '&magnify=1' : ''}${extra}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(settleMs);
  return ctx;
}

// ---- Scenario 1: plain desktop viewer on a fresh container -----------------
// The product contract this whole fix serves: liveview WITHOUT magnify shows
// the full 1920x1080 desktop on load.
console.log('\n### 1. plain desktop viewer (no magnify)');
{
  const ctx = await runViewer({ w: 1728, h: 866, settleMs: 9000 });
  const g = geometry();
  check('X screen is boot 1920x1080', g.sw === 1920 && g.sh === 1080, `screen=${g.sw}x${g.sh}`);
  check('every Chromium window == screen', g.windows.length > 0 && g.windows.every((x) => x.w === g.sw && x.h === g.sh), JSON.stringify(g.windows));
  const band = await blackBottomRows(browser, framebufferShot('plain-desktop'));
  check('no black band in framebuffer', band.black <= 2, `${band.black} black rows of ${band.h}`);
  await ctx.close();
}

// ---- Scenario 2: magnify phone viewer — the tall fit ------------------------
// fit-to-width grows the screen far past the 1080 boot window; the watcher
// must grow the window with it, or everything below row 1080 is X root.
console.log('\n### 2. magnify phone viewer (fit-to-width)');
{
  // fixedw forces the remote layout wider than the display so fit-to-width
  // actually engages — the boot page reflows cleanly at 360px and would
  // otherwise decline the fit (fit.js: layoutW > dispW guard).
  const ctx = await runViewer({ w: 360, h: 690, dsf: 3, mobile: true, magnify: true, extra: '&fixedw=1072', settleMs: 14000 });
  const g = geometry();
  check('fit grew the screen past boot height', g.sh > 1080, `screen=${g.sw}x${g.sh}`);
  check('every Chromium window == grown screen', g.windows.length > 0 && g.windows.every((x) => x.w === g.sw && x.h === g.sh), JSON.stringify(g.windows));
  const band = await blackBottomRows(browser, framebufferShot('magnify-phone'));
  check('no black band under the tall fit', band.black <= 2, `${band.black} black rows of ${band.h}`);
  await ctx.close();
  // ---- Scenario 2b: magnify soft-reconnect keeps its geometry --------------
  // The viewer sends ?keep=1 on its websocket, so the first-connect reset must
  // NOT fire — resetting would bounce the page through a desktop relayout,
  // which reload-on-resize sites answer with a state-losing reload.
  console.log('\n### 2b. magnify reconnect inside the restore delay (keep=1)');
  const resetLines = () => {
    try { return Number(execSync(`docker exec ${CONTAINER} sh -c "grep -c 'first viewer connected onto' /var/log/app/entrypoint.log"`).toString().trim()); }
    catch { return 0; }
  };
  const resetsBefore = resetLines();
  await new Promise((r) => setTimeout(r, 800)); // inside the 3s restore delay
  const ctx2b = await runViewer({ w: 360, h: 690, dsf: 3, mobile: true, magnify: true, extra: '&fixedw=1072', settleMs: 14000 });
  check('no boot reset fired for the keep=1 reconnect', resetLines() === resetsBefore, `reset lines ${resetsBefore} -> ${resetLines()}`);
  const g2b = geometry();
  check('reconnected fit is tall again with window matched', g2b.sh > 1080 && g2b.windows.every((x) => x.w === g2b.sw && x.h === g2b.sh), `screen=${g2b.sw}x${g2b.sh} windows=${JSON.stringify(g2b.windows)}`);
  await ctx2b.close();
  // ---- Scenario 3: immediate changeover to a plain viewer ------------------
  // Reconnecting INSIDE the 3s restore delay used to cancel the restore and
  // inherit the phone-shaped screen forever; the first-connect reset must put
  // the screen back to boot geometry before the new handshake.
  console.log('\n### 3. plain viewer connecting right after magnify left');
  await new Promise((r) => setTimeout(r, 800)); // inside the 3s restore delay
  const ctx3 = await runViewer({ w: 1728, h: 866, settleMs: 9000 });
  const g3 = geometry();
  check('screen reset to boot 1920x1080', g3.sw === 1920 && g3.sh === 1080, `screen=${g3.sw}x${g3.sh}`);
  check('every Chromium window == screen', g3.windows.length > 0 && g3.windows.every((x) => x.w === g3.sw && x.h === g3.sh), JSON.stringify(g3.windows));
  const band3 = await blackBottomRows(browser, framebufferShot('changeover-plain'));
  check('no black band after changeover', band3.black <= 2, `${band3.black} black rows of ${band3.h}`);
  await ctx3.close();
}

await browser.close();

console.log('\n### proxy log evidence');
try {
  console.log(execSync(`docker exec ${CONTAINER} sh -c "grep -hE 're-fit|first viewer|screen restored|window watcher' /var/log/app/entrypoint.log | tail -12"`).toString());
} catch { /* log format drift is not a failure */ }

console.log(`screenshots: ${OUT}`);
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nALL SCENARIOS PASS');
