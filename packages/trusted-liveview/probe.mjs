// Opens the REAL encrypted control channel to a pod with the production client
// library, triggers a blocking alert() in the pod's browser over CDP, and prints
// the dialog envelope exactly as it arrives. The shape is the whole test: the
// viewer unwraps one level, so payload must be the BARE dialog state.
import { readFileSync } from 'node:fs';
import { createLiveViewE2EClient, createLiveViewSessionKey } from '@popcorn/trusted-liveview';

const [paramsFile, podKey, viewerPort, cdpPort] = process.argv.slice(2);
const params = JSON.parse(readFileSync(paramsFile, 'utf8'));
const base = `ws://127.0.0.1:${viewerPort}`;

const key = await createLiveViewSessionKey();
const client = createLiveViewE2EClient({
  sessionId: params.sessionId,
  liveViewE2e: {
    version: 1,
    protocol: 'Noise_IK_25519_ChaChaPoly_SHA256',
    podPublicKey: podKey,
    podUid: params.podUid,
    e2eRfbUrl: `${base}/e2e/rfb`,
    e2eControlUrl: `${base}/e2e/control`,
    bindingSecret: params.bindingSecret,
  },
}, key, { allowInsecureLoopback: true });

const socket = await client.connectControl();
console.log('handshake: OK (Noise_IK over ws)');

const seen = [];
socket.onmessage = (event) => {
  const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
  seen.push(text);
  const envelope = JSON.parse(text);
  if (envelope.type === 'dialog') {
    console.log('\nRAW ENVELOPE : ' + text);
    const payload = envelope.payload;
    const doubled = payload && typeof payload === 'object' && payload.dialog !== undefined;
    console.log('payload.open : ' + JSON.stringify(payload?.open));
    console.log('payload.type : ' + JSON.stringify(payload?.type));
    console.log('payload.message: ' + JSON.stringify(payload?.message));
    console.log('\nVERDICT      : ' + (doubled
      ? 'DOUBLE-WRAPPED — the viewer would read open:undefined and tear the sheet down'
      : 'single-wrapped — the sheet renders and can be answered'));
    process.exit(doubled ? 1 : 0);
  }
};

// Drive the pod's own browser: navigate to a page whose button fires alert(),
// then click it. alert() blocks the page, which is what makes the pod publish
// the dialog to every viewer.
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => { cdp.onopen = resolve; });
let id = 0;
const send = (method, params = {}) => cdp.send(JSON.stringify({ id: ++id, method, params }));
send('Page.navigate', { url: 'data:text/html,<button id=b onclick="alert(%27Acknowledge to continue.%27)">go</button>' });
setTimeout(() => send('Runtime.evaluate', { expression: "document.querySelector('#b').click()", awaitPromise: false }), 2500);

setTimeout(() => {
  console.log('\nno dialog envelope arrived in 20s. frames seen: ' + JSON.stringify(seen.slice(0, 6)));
  process.exit(2);
}, 20000);
