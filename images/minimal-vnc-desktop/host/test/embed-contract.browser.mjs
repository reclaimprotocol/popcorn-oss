// embed-contract.browser.mjs — the embedding contract, checked in a REAL browser.
//
// WHY THIS EXISTS, specifically.
//
// PopcornHost.layer() is documented as "call it before setting src and your
// iframe becomes a compliant full-viewport layer". It did not work. Every parsed
// <iframe> already owns a contentDocument (the blank one the engine gives it
// before anything navigates it), and the "is this frame live?" guard tested for
// exactly that — so layer() decided a brand-new frame was a running session and
// refused to move it out of the embedder's wrapper. Pages that followed the
// documented recipe kept the hazardous layout AND were told, in a console they
// could not read, to do the thing they had just done.
//
// It survived because the only thing checking it was kbd/test/host-stub.mjs,
// which modelled contentWindow but not contentDocument. A stub can only disagree
// with a browser in the direction nobody wrote a test for, and the embedding
// contract is a BROWSER behaviour: raster scale, compositing, iframe lifetime,
// permission policy. So one test drives the real thing.
//
// It is not part of `node --test kbd/test/*.test.mjs` (different extension, on
// purpose) because it needs a browser and a pod. It SKIPS, loudly and with exit
// code 0, when either is missing, so it is safe to wire into CI unconditionally
// and useful the moment the environment is there.
//
//   docker run --rm -d --name pcn-pod --tmpfs /dev/shm:size=1g -p 6080:6080 \
//     popcorn/minimal-vnc-desktop:local
//   cd images/minimal-vnc-desktop && python3 -m http.server 8080 &
//   node host/test/embed-contract.browser.mjs
//
//   VIEWER_BASE=http://127.0.0.1:6080  HOST_BASE=http://127.0.0.1:8080/host
//   HEADFUL=1                          watch it run
import { launch, browserWs, CDP, sleep, chromePath } from './cdp.mjs';

const PORT = Number(process.env.CDP_PORT || 9444);
const VIEWER_BASE = process.env.VIEWER_BASE || 'http://127.0.0.1:6080';
const HOST_BASE = process.env.HOST_BASE || 'http://127.0.0.1:8080/host';
const SETTLE_MS = Number(process.env.SETTLE_MS || 18000);

// A Pixel-class phone: the DPR is the whole point, since `dev` (remote px per
// device px) is the number the sharpness complaint is about.
const DEVICE = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true };
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

function skip(why) {
  console.log('SKIP embed-contract: ' + why);
  process.exit(0);
}

async function reachable(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2500);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch (_) { return false; }
}

// What each frame can tell us about its own embedding. Structural only — sizes,
// ratios and the audit's codes; nothing derived from page content.
const PROBE = `(function () {
  var out = { url: location.href, top: window === window.top, dpr: window.devicePixelRatio };
  try {
    var f = document.querySelector('iframe');
    if (f && window.PopcornHost) out.audit = window.PopcornHost.auditLayout(f);
  } catch (e) { out.auditError = true; }
  try {
    var c = document.querySelector('#screen canvas') || document.querySelector('canvas');
    if (c && c.width) {
      var r = c.getBoundingClientRect();
      if (r.width) out.scale = {
        fb: [c.width, c.height],
        css: [Math.round(r.width), Math.round(r.height)],
        sc: +(c.width / r.width).toFixed(3),
        dev: +(c.width / r.width / window.devicePixelRatio).toFixed(3),
      };
    }
  } catch (e) {}
  return JSON.stringify(out);
})()`;

async function probe(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const contexts = new Map();
  const warnings = [];
  cdp.on((m) => {
    if (m.sessionId !== S) return;
    if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id, m.params.context.origin);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
      warnings.push(m.params.args.map((a) => (a.value !== undefined ? String(a.value) : '')).join(' '));
    }
  });
  await cdp.send('Runtime.enable', {}, S);
  await cdp.send('Page.enable', {}, S);
  await cdp.send('Emulation.setDeviceMetricsOverride', DEVICE, S);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l' }, S);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);
  await cdp.send('Page.navigate', { url }, S);
  await sleep(SETTLE_MS);

  const frames = [];
  for (const [id] of contexts) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: PROBE, contextId: id, returnByValue: true }, S);
      if (r.result && r.result.value) frames.push(JSON.parse(r.result.value));
    } catch (_) { /* context went away mid-probe */ }
  }
  await cdp.send('Target.closeTarget', { targetId });
  return {
    hosts: frames.filter((f) => f.audit),
    viewer: frames.find((f) => f.scale) || null,
    warnings,
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

const q = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const COMMON = { viewer: VIEWER_BASE, diag: '1', quality: '9', compression: '9' };

(async () => {
  if (!chromePath()) skip('no Chrome (set CHROME_PATH)');
  if (!await reachable(VIEWER_BASE + '/liveview.html')) skip('no pod at ' + VIEWER_BASE);
  if (!await reachable(HOST_BASE + '/test-min.html')) skip('no harness at ' + HOST_BASE);

  launch({ port: PORT, profile: '/tmp/pcn-embed-contract-profile', headless: process.env.HEADFUL !== '1' });
  const cdp = new CDP(await browserWs(PORT));
  await cdp.ready;

  // 1. The bare control. If this is not clean, nothing below means anything.
  {
    const r = await probe(cdp, HOST_BASE + '/test-min.html?' + q(COMMON));
    const a = r.hosts[0] && r.hosts[0].audit;
    check('bare embed audits clean', !!a && a.ok, a ? a.issues.join(',') || 'ok' : 'no audit');
    check('bare embed connects and reports its scale', !!r.viewer,
      r.viewer ? JSON.stringify(r.viewer.scale) : 'no canvas');
  }

  // 2. The wrapper case — the one the stub could not see. test-host.html puts the
  //    iframe inside a <div> and calls layer() before src, exactly as documented.
  //    A 'nested' finding here means layer() has stopped reparenting again.
  {
    const r = await probe(cdp, HOST_BASE + '/test-host.html?' + q(COMMON));
    const a = r.hosts[0] && r.hosts[0].audit;
    check('layer() lifts a wrapped iframe out of its wrapper', !!a && a.ok,
      a ? a.issues.join(',') || 'ok' : 'no audit');
    check('and does not warn about restarting a session that has not started',
      !r.warnings.some((w) => /not reparenting a live frame/.test(w)),
      r.warnings.find((w) => /reparent/.test(w)) || '');
  }

  // 3. Three levels — the deployed shape. EVERY hop must be compliant; a chain is
  //    only as sharp as its worst frame, and only that frame can report itself.
  {
    const r = await probe(cdp, HOST_BASE + '/test-host.html?nest=1&' + q(COMMON));
    check('the nested chain audits both hops', r.hosts.length >= 2,
      'saw ' + r.hosts.length + ' host frame(s)');
    check('every hop in the nested chain is compliant', r.hosts.every((h) => h.audit.ok),
      r.hosts.map((h) => (h.audit.issues.join(',') || 'ok')).join(' | '));
  }

  // 4. The deliberate hazard. This one must FAIL the audit — a contract check that
  //    cannot detect a violation is not checking anything, and the numbers stay
  //    identical to the clean case, which is exactly why the codes have to work.
  {
    const r = await probe(cdp, HOST_BASE + '/test-host.html?badlayout=1&' + q(COMMON));
    const a = r.hosts[0] && r.hosts[0].audit;
    const want = ['transform', 'scroll-ancestor', 'flex-or-grid-parent'];
    check('a hazardous layout is DETECTED, not silently accepted',
      !!a && !a.ok && want.every((c) => a.issues.includes(c)),
      a ? a.issues.join(',') : 'no audit');
    check('and it is invisible in the numbers (which is why the codes exist)',
      !!r.viewer && r.viewer.scale.sc === 1,
      r.viewer ? JSON.stringify(r.viewer.scale) : 'no canvas');
  }

  cdp.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('embed-contract error: ' + (e && e.message)); process.exit(1); });
