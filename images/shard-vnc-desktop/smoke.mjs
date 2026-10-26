// Node >=22. Run against the local Docker Desktop container from README.md.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { connect, evaluate } from '../../scripts/clearcote/cdp.mjs';

const base = process.env.SHARD_CDP_URL || 'http://127.0.0.1:19235';
const viewer = process.env.SHARD_VIEWER_URL || 'http://127.0.0.1:16085';
const manifest = await import('./runtime.json', { with: { type: 'json' } });
const fixture = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Popcorn ShardBrowser</title><style>body{font:24px sans-serif;margin:64px;background:#f5f7fb;color:#18324f}button{padding:16px;font:inherit}</style><h1>ShardBrowser is running in Popcorn</h1><p id="state">CDP navigation works.</p><button onclick="document.querySelector(\'#state\').textContent=\'Input works.\'">Test input</button>');
});
await new Promise(resolve => fixture.listen(0, '0.0.0.0', resolve));
let browser;
let page;
let targetId;
try {
  const version = await fetch(base + '/json/version').then(response => response.json());
  assert.ok(version.Browser.endsWith('/' + manifest.default.chromium_version));
  const html = await fetch(viewer + '/liveview.html').then(response => response.text());
  assert.ok(html.includes('<script type="module">'), 'bundled viewer is served');
  const rfb = new WebSocket(viewer.replace(/^http/, 'ws') + '/websockify');
  rfb.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { rfb.close(); reject(new Error('VNC handshake timed out')); }, 10_000);
    rfb.addEventListener('message', event => {
      clearTimeout(timer);
      try { assert.ok(Buffer.from(event.data).toString().startsWith('RFB ')); resolve(); }
      catch (error) { reject(error); }
      finally { rfb.close(); }
    }, { once: true });
    rfb.addEventListener('error', () => { clearTimeout(timer); reject(new Error('VNC WebSocket failed')); }, { once: true });
  });
  browser = await connect(version.webSocketDebuggerUrl);
  ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
  const targets = await fetch(base + '/json/list').then(response => response.json());
  page = await connect(targets.find(target => target.id === targetId).webSocketDebuggerUrl);
  const host = process.env.SHARD_FIXTURE_HOST || 'host.docker.internal';
  const url = `http://${host}:${fixture.address().port}/`;
  const result = await page.send('Page.navigate', { url });
  assert.ok(!result.errorText, result.errorText);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate(page, 'document.title') === 'Popcorn ShardBrowser') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(await evaluate(page, 'document.title'), 'Popcorn ShardBrowser');
  const cookie = await evaluate(page, 'document.cookie');
  if (process.env.SHARD_EXPECT_PERSISTED === '1') assert.ok(cookie.includes('popcornShardSmoke=retained'), 'browser cookie survives restart');
  await evaluate(page, "document.cookie='popcornShardSmoke=retained; Max-Age=3600; Path=/'");
  const point = await evaluate(page, '(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  assert.equal(await evaluate(page, 'document.querySelector("#state").textContent'), 'Input works.');
  const persona = await evaluate(page, '({ua:navigator.userAgent,platform:navigator.platform,language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,screen:[screen.width,screen.height],window:[innerWidth,innerHeight],dpr:devicePixelRatio})');
  assert.equal(persona.language, process.env.SHARD_LANGUAGE || 'en-US');
  assert.equal(persona.timezone, process.env.SHARD_TIMEZONE || 'UTC');
  const { targetInfos } = await browser.send('Target.getTargets');
  assert.ok(targetInfos.some(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://')), 'Popcorn extension worker is loaded');
  const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
  assert.ok(screenshot.data.length > 1000);
  if (process.env.SHARD_SCREENSHOT) await writeFile(process.env.SHARD_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify({ browser: version.Browser, viewer: 'ok', vnc: 'ok', navigation: 'ok', input: 'ok', extension: 'ok', screenshot: 'ok', persona }, null, 2));
} finally {
  if (browser && targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  page?.close();
  browser?.close();
  fixture.closeAllConnections();
  fixture.close();
}
