import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connect, diagnosticJSON, evaluate } from './cdp.mjs';
import { parseExitIP, proxyConfig, proxyAuthResponse, tlsSummary, verifyEgress } from './egress.mjs';
import { captureHAR } from './har.mjs';

const { values } = parseArgs({ options: {
  cdp: { type: 'string', default: 'http://127.0.0.1:19233' },
  url: { type: 'string', default: 'https://www.delta.com/' },
  har: { type: 'string', default: '/tmp/popcorn-clearcote-session.har' },
  'verify-only': { type: 'boolean', default: false },
} });
const cdp = new URL(values.cdp);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(cdp.hostname) || cdp.username || cdp.password
    || !['http:', 'https:'].includes(cdp.protocol)) throw new Error('Use a loopback CDP endpoint');
const destination = new URL(values.url);
if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
  throw new Error('Target must be an HTTP(S) URL without embedded credentials');
}
const config = proxyConfig(process.env);
const harPath = resolve(values.har);
let browser, page, contextId, stopCapture;
let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await stopCapture?.(); }
  catch { console.error('Final HAR write failed'); process.exitCode = 1; }
  if (browser && contextId) await browser.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
  page?.close(); browser?.close();
}

async function newPage(browserContextId, background = true) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId, background });
  const targets = await fetch(cdp.origin + '/json/list', { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const target = targets.find(target => target.id === targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error('New browser target missing');
  return { targetId, client: await connect(target.webSocketDebuggerUrl) };
}

try {
  const version = await fetch(cdp.origin + '/json/version', { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  browser = await connect(version.webSocketDebuggerUrl);
  // Only public diagnostic traffic uses this explicit direct context. No login
  // page is opened until the separate proxy context passes every check.
  const direct = await browser.send('Target.createBrowserContext', { proxyServer: 'direct://', disposeOnDetach: true });
  let baseline;
  const probe = await newPage(direct.browserContextId);
  try {
    await probe.client.send('Network.enable');
    await probe.client.send('Network.setCacheDisabled', { cacheDisabled: true });
    const ip = await diagnosticJSON(probe.client, 'https://api.ipify.org?format=json', 'ip');
    baseline = tlsSummary(await diagnosticJSON(probe.client, 'https://tls.peet.ws/api/all', 'tls'));
    if (parseExitIP(ip.ip) !== baseline.ip) throw new Error('Direct diagnostic endpoints disagree; cannot establish routing baseline');
  } finally {
    probe.client.close();
    await browser.send('Target.disposeBrowserContext', { browserContextId: direct.browserContextId });
  }

  const context = await browser.send('Target.createBrowserContext', {
    proxyServer: config.server, proxyBypassList: 'localhost,127.0.0.1,[::1]', disposeOnDetach: true,
  });
  contextId = context.browserContextId;
  const target = await newPage(contextId);
  page = target.client;
  const attempted = new Set();
  page.onEvent(message => {
    const params = message.params || {};
    if (message.method === 'Fetch.requestPaused') {
      void page.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    } else if (message.method === 'Fetch.authRequired') {
      const response = proxyAuthResponse(params.authChallenge, config, attempted.has(params.requestId));
      if (response.response === 'ProvideCredentials') attempted.add(params.requestId);
      if (attempted.size > 4096) attempted.clear();
      void page.send('Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: response }).catch(() => {});
    }
  });
  stopCapture = await captureHAR(page, harPath);
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  const geo = await diagnosticJSON(page, 'https://geo.brdtest.com/mygeo.json', 'country');
  if (geo.country !== config.country) throw new Error('Proxy country does not match the requested country');
  const samples = [];
  for (let round = 0; round < 2; round++) {
    const ip = await diagnosticJSON(page, 'https://api.ipify.org?format=json', 'ip');
    const tls = tlsSummary(await diagnosticJSON(page, 'https://tls.peet.ws/api/all', 'tls'));
    samples.push({ endpoint: 'ipify', ip: parseExitIP(ip.ip) }, { endpoint: 'tls', ...tls });
    console.log(JSON.stringify({ round: round + 1, exitIP: tls.ip, ja4: tls.ja4, httpVersion: tls.httpVersion, resumptionOffered: tls.resumptionOffered }));
  }
  const exitIP = verifyEgress(samples, baseline);
  const metadata = await evaluate(page, '(async()=>({userAgent:navigator.userAgent,platform:navigator.platform,clientHints:await navigator.userAgentData?.getHighEntropyValues(["fullVersionList","platformVersion"]),languages:navigator.languages,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,screen:{width:screen.width,height:screen.height},viewport:{width:innerWidth,height:innerHeight}}))()');
  await writeFile(harPath + '.verification.json', JSON.stringify({ country: geo.country, baseline, samples, metadata }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ verified: true, exitIP, country: geo.country, har: harPath }));
  if (!values['verify-only']) {
    await page.send('Network.setCacheDisabled', { cacheDisabled: false });
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: target.targetId });
    await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    await browser.send('Target.activateTarget', { targetId: target.targetId });
    await page.send('Page.navigate', { url: destination.href });
    console.log('Site opened. Keep this process running for proxy authentication and sanitized capture. Ctrl+C closes this test session.');
    await new Promise(resolve => {
      process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
      page.socket.addEventListener('close', resolve, { once: true });
    });
  }
} catch (error) {
  // Log bounded messages, never the proxy config, request bodies or challenge tokens.
  console.error('Session stopped: ' + error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
