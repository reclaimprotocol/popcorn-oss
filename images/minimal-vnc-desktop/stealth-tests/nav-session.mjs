// Steer an already-running staging session using ONLY its live-view URL.
//
// Two constraints shape this:
//   1. Staging exposes no GET /v1/sessions/{id} (404), so once a launcher drops
//      CDP there is no handle left. But session-urls.ts derives every endpoint
//      from the (sessionId, token) pair the live-view URL already carries, so
//      the CDP URL is reconstructable from it.
//   2. The live-view token has the RESTRICTED scope, whose allowlist
//      (popcorn-images/server/lib/devtoolsproxy/proxy.go createAllowedCommandsMap)
//      permits Input.*, Page.enable, Page.reload, Target.* — but NOT
//      Page.navigate. And chromium runs --kiosk, so there is no omnibox for a
//      human to type into either.
//
// So navigation happens the only way that scope allows: synthesise Alt+Left
// (browser Back) as key events and walk back through history.
//
// Raw CDP rather than playwright: connectOverCDP sends Browser.setDownloadBehavior
// on handshake, which this scope rejects, killing the connection before use.
//
// Usage:
//   LIVEVIEW='<live view url>' node nav-session.mjs          # back once
//   LIVEVIEW='…' STEPS=3 node nav-session.mjs               # back 3 times
//   LIVEVIEW='…' ACTION=reload node nav-session.mjs
const LIVEVIEW = process.env.LIVEVIEW;
const STEPS = parseInt(process.env.STEPS || '1', 10);
const ACTION = process.env.ACTION || 'back';
if (!LIVEVIEW) { console.error('Set LIVEVIEW.'); process.exit(1); }

const m = LIVEVIEW.match(/^(https?:\/\/[^/]+)\/(?:vnc|liveview)\/([^/]+)\/([^/]+)\//);
if (!m) { console.error('Could not parse sessionId/token from LIVEVIEW.'); process.exit(1); }
const [, origin, sessionId, token] = m;
const ws = new WebSocket(`${origin.replace(/^https?:/, 'wss:')}/cdp/${sessionId}/${token}/`);

let id = 0;
const pending = new Map();
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
ws.addEventListener('error', (e) => { console.error('[nav] socket error:', e.message || e.type); process.exit(1); });

const urlOf = async () => {
  const { targetInfos } = await send('Target.getTargets');
  return (targetInfos.find((t) => t.type === 'page') || {}).url || '(none)';
};

ws.addEventListener('open', async () => {
  try {
    console.log('[nav] at:', await urlOf());
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const { sessionId: sid } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await send('Page.enable', {}, sid).catch(() => {});
    await send('Input.enable', {}, sid).catch(() => {});

    if (ACTION === 'reload') {
      await send('Page.reload', {}, sid);
      console.log('[nav] reloaded');
    } else {
      // Alt+Left == Back. modifiers bitmask: Alt = 1.
      for (let i = 0; i < STEPS; i++) {
        for (const type of ['rawKeyDown', 'keyUp']) {
          await send('Input.dispatchKeyEvent', {
            type, modifiers: 1, key: 'ArrowLeft', code: 'ArrowLeft',
            windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37,
          }, sid);
        }
        await sleep(2500);
        console.log(`[nav] back ${i + 1}/${STEPS} ->`, await urlOf());
      }
    }
    await sleep(1500);
    console.log('[nav] final:', await urlOf());
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('[nav] failed:', e.message);
    process.exit(1);
  }
});
