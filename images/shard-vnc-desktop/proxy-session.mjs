// Run on the host; proxy credentials stay in this process and CDP auth replies.
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { connect, diagnosticJSON, evaluate } from '../../scripts/clearcote/cdp.mjs';
import { proxyAuthResponse, tlsSummary, verifyEgress } from '../../scripts/clearcote/egress.mjs';

const { values } = parseArgs({ options: {
  cdp: { type: 'string', default: 'http://127.0.0.1:19237' },
  'proxy-file': { type: 'string' },
} });
if (!values['proxy-file']) throw new Error('--proxy-file is required (JSON with a proxy URL)');
const endpoint = new URL(values.cdp);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password
  || !['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Use a loopback CDP endpoint');
const proxy = new URL(JSON.parse(await readFile(values['proxy-file'], 'utf8')).proxy);
if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Use an HTTP(S) proxy');
const config = { server: proxy.origin, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) };
const version = await fetch(endpoint.origin + '/json/version').then(r => r.json());
const browser = await connect(version.webSocketDebuggerUrl);
let page;
let changed = false;
let stopping = false;
async function extension(type, config) {
  return evaluate(page, `new Promise((resolve,reject)=>{
    const id='popcorn-route-'+crypto.randomUUID();
    const timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(new Error('Proxy extension timed out'))},5000);
    function listener(e){if(e.source===window&&e.data?.type==='PCN_PROXY_RESPONSE'&&e.data.requestId===id){
      clearTimeout(timer);window.removeEventListener('message',listener);
      if(e.data.success)resolve({configured:!!e.data.result});else reject(new Error('Proxy extension rejected request'));
    }}
    window.addEventListener('message',listener);
    window.postMessage({type:${JSON.stringify(type)},config:${JSON.stringify(config)},direction:'to-extension',requestId:id},'*');
  })`);
}
async function cleanup() {
  if (stopping) return;
  stopping = true;
  if (changed && page) {
    // Keep auth active until the proxy is cleared. Do not leave a credentialed
    // route behind when the process responsible for authentication goes away.
    try { await extension('PCN_PROXY_CLEAR'); }
    catch { console.error('Could not clear extension proxy; restart this test container before further browsing.'); }
  }
  page?.close(); browser.close();
}
try {
  const { browserContextIds } = await browser.send('Target.getBrowserContexts');
  const { targetInfos } = await browser.send('Target.getTargets');
  const target = targetInfos.find(t => t.type === 'page' && !browserContextIds.includes(t.browserContextId));
  if (!target) throw new Error('Regular profile tab missing');
  const targets = await fetch(endpoint.origin + '/json/list').then(r => r.json());
  page = await connect(targets.find(t => t.id === target.targetId).webSocketDebuggerUrl);
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  // First use a public endpoint, where the extension content bridge is present.
  const directIP = await diagnosticJSON(page, 'https://api.ipify.org?format=json', 'ip');
  if ((await extension('PCN_PROXY_GET')).configured) throw new Error('Existing extension proxy found; refusing to replace it');
  const baseline = tlsSummary(await diagnosticJSON(page, 'https://tls.peet.ws/api/all', 'tls'));
  if (baseline.ip !== directIP.ip) throw new Error('Direct diagnostic endpoints disagree');
  const attempted = new Set();
  page.onEvent(({ method, params }) => {
    if (method === 'Fetch.requestPaused') void page.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    if (method === 'Fetch.authRequired') {
      const response = proxyAuthResponse(params.authChallenge, config, attempted.has(params.requestId));
      if (response.response === 'ProvideCredentials') attempted.add(params.requestId);
      void page.send('Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: response }).catch(() => {});
    }
  });
  await page.send('Fetch.enable', { handleAuthRequests: true });
  changed = true;
  await extension('PCN_PROXY_SET', { scheme: proxy.protocol.slice(0, -1), host: proxy.hostname,
    port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)), bypassList: ['localhost', '127.0.0.1', '[::1]'] });
  const samples = [];
  for (let round = 0; round < 2; round++) {
    const ip = await diagnosticJSON(page, 'https://api.ipify.org?format=json', 'ip');
    const tls = tlsSummary(await diagnosticJSON(page, 'https://tls.peet.ws/api/all', 'tls'));
    samples.push({ endpoint: 'ipify', ip: ip.ip }, { endpoint: 'tls', ...tls });
    console.log(JSON.stringify({ round: round + 1, exitIP: tls.ip }));
  }
  const exitIP = verifyEgress(samples, baseline);
  await page.send('Network.setCacheDisabled', { cacheDisabled: false });
  await page.send('Page.bringToFront');
  await page.send('Page.navigate', { url: 'https://www.delta.com/' });
  console.log(JSON.stringify({ verified: true, exitIP, routing: 'Popcorn proxy extension', targetId: target.targetId }));
  console.log('Delta opened. Keep this process running for proxy authentication. Ctrl+C clears the proxy.');
  await new Promise(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
    page.socket.addEventListener('close', resolve, { once: true });
  });
} catch (error) {
  console.error('Proxy session stopped: ' + error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
