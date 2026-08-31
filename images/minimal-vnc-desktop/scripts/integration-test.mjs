// integration-test.mjs — end-to-end checks against a RUNNING container.
//
// These cover the behaviour the unit suites cannot: the real extension publishing
// over the real /kbd hub, real CDP dialogs on real page targets, real touch frames
// on /input, and a real cross-origin iframe. Everything asserted here is something
// that was verified by reading code at least once and turned out to need proving.
//
//   docker run --rm -it --tmpfs /dev/shm:size=1g \
//     -p 6080:6080 -p 9226:9226 popcorn/minimal-vnc-desktop:local
//   node scripts/integration-test.mjs
//
// Zero dependencies (Node >= 22: global fetch + WebSocket). Env overrides:
//   NOVNC=http://localhost:6080  CDP=http://localhost:9226
//   HOSTGW=host.docker.internal  (how the CONTAINER reaches this machine)
//   ONLY=substring               (run only matching tests)

const NOVNC = process.env.NOVNC || 'http://localhost:6080';
const CDP = process.env.CDP || 'http://localhost:9226';
const HOSTGW = process.env.HOSTGW || 'host.docker.internal';
const ONLY = process.env.ONLY || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny test framework ---------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(got, want, msg) {
  if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---- CDP client ------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} (${JSON.stringify(m.error.data || '')})`));
        else resolve(m.result);
        return;
      }
      for (const l of this.listeners.slice()) l(m);
    };
  }
  static async open() {
    const v = await (await fetch(`${CDP}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
    });
  }
  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
  async waitFor(pred, timeout = 15000, what = 'event') {
    return new Promise((resolve, reject) => {
      const off = this.on((m) => { if (pred(m)) { off(); clearTimeout(t); resolve(m); } });
      const t = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${what}`)); }, timeout);
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }

  async pageTargets() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page');
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }
  // A fresh page we own, attached, with Runtime + Page enabled. Execution contexts
  // are recorded as they appear so a subframe's page world can be reached by origin.
  async newPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const sessionId = await this.attach(targetId);
    const contexts = [];
    this.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
      if (m.method === 'Runtime.executionContextsCleared') contexts.length = 0;
    });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.waitFor((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId, 20000, `${url} to load`)
      .catch(() => {}); // some pages fire it before we subscribe; the eval below is the real gate
    const contextFor = async (match, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        // Page-world contexts only: the extension's isolated world would let a test
        // "forge" a message from the very place that is allowed to send it.
        const c = contexts.find((c) => (c.origin || '').includes(match) && !(c.auxData && c.auxData.type === 'isolated'));
        if (c) return c.id;
        if (Date.now() > deadline) {
          throw new Error(`no page-world execution context for ${match} (saw ${contexts.map((c) => c.origin).join(', ')})`);
        }
        await sleep(100);
      }
    };
    return { targetId, sessionId, contexts, contextFor };
  }
  async eval(sessionId, expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.result?.value ?? '')}`);
    return r.result.value;
  }
  async evalIn(sessionId, contextId, expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, contextId, userGesture: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text}`);
    return r.result.value;
  }
  // Fire-and-forget: for expressions that BLOCK (alert/confirm), where waiting for
  // the response would deadlock the test.
  evalNoWait(sessionId, expression) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, userGesture: true }, sessionId }));
  }
}

// ---- fake viewer on /kbd ---------------------------------------------------
class Viewer {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      this.frames.push(m);
    };
  }
  static async open({ mirror = false } = {}) {
    const ws = new WebSocket(`${NOVNC.replace('http', 'ws')}/kbd`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const v = new Viewer(ws);
    if (mirror) v.send({ mirror: { on: true } });
    await sleep(150); // let the opt-in reach the extension
    return v;
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  clear() { this.frames = []; }
  async waitFor(pred, timeout = 12000, what = 'frame') {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  }
  // Same, but returns the dialog/popup PAYLOAD rather than the envelope — seq and
  // notify live inside it, and reading them off the envelope silently yields
  // undefined, which then "answers" a dialog that does not exist.
  async waitForDialog(pred, timeout = 12000, what = 'a dialog frame') {
    const f = await this.waitFor((f) => f.dialog && pred(f.dialog), timeout, what);
    return f.dialog;
  }
  async waitForPopup(pred, timeout = 12000, what = 'a popup frame') {
    const f = await this.waitFor((f) => f.popup && pred(f.popup), timeout, what);
    return f.popup;
  }
  // The CURRENT advertisement, not the first one seen: the sequence number is bumped
  // whenever the front window changes, and answering with a stale seq is (correctly)
  // ignored by the proxy.
  latestPopup() {
    const all = this.popups();
    return all.length ? all[all.length - 1] : null;
  }
  states() { return this.frames.filter((f) => typeof f.editable === 'boolean'); }
  dialogs() { return this.frames.filter((f) => f.dialog).map((f) => f.dialog); }
  popups() { return this.frames.filter((f) => f.popup).map((f) => f.popup); }
  close() { try { this.ws.close(); } catch (_) {} }
}

// ---- host-side pages, for the cross-origin iframe test ---------------------
// Two ports on THIS machine = two origins the container can both reach. A data:
// or about:blank iframe would not do: the extension has to inject into both.
import http from 'node:http';

const CHILD_HTML = `<!doctype html><title>child</title>
<body style="margin:0"><div style="height:40px"></div>
<input id="ci" style="position:absolute;left:20px;top:60px;width:200px;height:30px">
<script>window.__forge = function () {
  parent.postMessage({__pcnKbdFrame:1,state:{editable:true,rect:{x:0,y:0,w:99,h:99},rects:[{x:0,y:0,w:99,h:99}],sync:{sensitive:false,val:'forged'},hints:{tag:'INPUT'},focusKey:'forged'}},'*');
  parent.postMessage({__pcnKbdAbs:1,x:99999,y:99999},'*');
};</script>`;

function serve(port, body) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(port, '0.0.0.0', () => resolve(srv)));
}

// focusPage makes our test page the window the container considers foreground, and
// waits until the page itself agrees (document.hasFocus). background.js publishes
// ONLY the focused tab's frames and the proxy routes input to the focused window, so
// a test that skips this is asserting on another window's state.
async function focusPage(cdp, page, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await cdp.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {});
    await cdp.send('Page.bringToFront', {}, page.sessionId).catch(() => {});
    if (await cdp.eval(page.sessionId, 'document.hasFocus()').catch(() => false)) {
      await sleep(600); // let the extension's focus claim reach the proxy
      return;
    }
    if (Date.now() > deadline) throw new Error('could not give the test page window focus');
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

test('Accept-Encoding q-values are honoured', async () => {
  const enc = async (h) => {
    const r = await fetch(`${NOVNC}/liveview.html`, { headers: { 'accept-encoding': h } });
    await r.arrayBuffer();
    return r.headers.get('content-encoding') || '';
  };
  // fetch() decodes transparently but still reports the header it negotiated.
  assertEq(await enc('gzip;q=0, identity'), '', 'gzip refused with q=0 must not be served');
  assertEq(await enc('br;q=0, gzip;q=0'), '', 'every variant refused -> raw file');
  const ok = await enc('gzip');
  assert(ok === 'gzip' || ok === '', `plain gzip -> ${ok || 'raw'} (raw only if no .gz on disk)`);
});

test('media queries keep compound and negated logic', async ({ cdp, page }) => {
  const got = await cdp.eval(page.sessionId, `JSON.stringify({
    browser: matchMedia('(display-mode: browser)').matches,
    notBrowser: matchMedia('not (display-mode: browser)').matches,
    compound: matchMedia('(display-mode: browser) and (min-width: 9999px)').matches,
    fullscreen: matchMedia('(display-mode: fullscreen)').matches,
    standalone: matchMedia('(display-mode: standalone)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    coarse: matchMedia('(pointer: coarse)').matches,
    hover: matchMedia('(hover: hover)').matches,
    upper: matchMedia('(DISPLAY-MODE: Browser)').matches,
    mediaEcho: matchMedia('(display-mode: browser)').media,
    unrelated: matchMedia('(min-width: 1px)').matches
  })`);
  const m = JSON.parse(got);
  assertEq(m.browser, true, 'display-mode: browser');
  assertEq(m.notBrowser, false, 'not (display-mode: browser)');
  assertEq(m.compound, false, '(display-mode: browser) and (min-width: 9999px)');
  assertEq(m.fullscreen, false, 'display-mode: fullscreen');
  assertEq(m.standalone, false, 'display-mode: standalone');
  assertEq(m.fine, true, 'pointer: fine');
  assertEq(m.coarse, false, 'pointer: coarse');
  assertEq(m.hover, true, 'hover: hover');
  assertEq(m.upper, true, 'feature names are case-insensitive');
  assert(/display-mode/.test(m.mediaEcho), `media echoes the original query, got ${m.mediaEcho}`);
  assertEq(m.unrelated, true, 'untouched queries still evaluate');
});

test('window.open: content links in place, popups get a real window', async ({ cdp, page }) => {
  const ids = async () => new Set((await cdp.pageTargets()).map((t) => t.targetId));
  const before = await ids();

  // A featureless real-URL call navigates in place and opens nothing.
  await cdp.eval(page.sessionId, `window.open('${`http://${HOSTGW}:8099/?inplace=1`}', '_blank') === window`);
  await sleep(1000);
  const afterLink = await ids();
  assertEq(afterLink.size, before.size, 'a content link must not create a target');

  // A blank bootstrap call, and a named target, must each get a real window.
  const opened = [];
  for (const expr of [`window.open()`, `window.open('', 'authWindow')`, `window.open('about:blank')`]) {
    const b = await ids();
    await cdp.eval(page.sessionId, `!!(${expr})`);
    await sleep(700);
    const a = await ids();
    const fresh = [...a].filter((t) => !b.has(t));
    assert(fresh.length === 1, `${expr} must open exactly one real window (opened ${fresh.length})`);
    opened.push(fresh[0]);
  }
  // Close ONLY what we opened, never the test page.
  for (const t of opened) {
    assert(t !== page.targetId, 'refusing to close the test page');
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }
  await sleep(600);
});

test('/kbd carries no field text by default, and text only for a mirror viewer', async ({ cdp, page }) => {
  await focusPage(cdp, page);
  const plain = await Viewer.open();
  try {
    await cdp.eval(page.sessionId, `var i = document.getElementById('pi'); i.value = 'hello'; i.blur(); i.focus(); 1`);
    const s = await plain.waitFor((f) => f.editable === true && f.sync && f.sync.len === 5, 12000,
      'an editable state from the extension');
    assertEq(s.sync.tail, false, 'trailing-space flag is published');
    assert(s.sync.val === undefined,
      `the DEFAULT channel must not carry the field value (got ${JSON.stringify(s.sync)}). ` +
      `If a ?mirror=1 viewer is open in a browser somewhere, close it: mirroring is on ` +
      `while ANY viewer wants it, so this assertion cannot hold.`);

    // Opt in from a second viewer: the extension is told, and republishes with text.
    const mirror = await Viewer.open({ mirror: true });
    try {
      const withVal = await mirror.waitFor((f) => f.editable === true && f.sync && typeof f.sync.val === 'string', 8000,
        'a mirror state carrying the value');
      assertEq(withVal.sync.val, 'hello', 'mirror viewer receives the real text');
    } finally {
      mirror.close();
      await sleep(400);
    }

    // ...and the value stops flowing once the mirror viewer leaves. A CHANGED value is
    // what guarantees a fresh state: identical states are deduped by the extension.
    plain.clear();
    await cdp.eval(page.sessionId, `var i = document.getElementById('pi'); i.value = 'hello there'; i.blur(); i.focus(); 1`);
    const after = await plain.waitFor((f) => f.editable === true && f.sync && f.sync.len === 11, 12000,
      'a state after the mirror viewer left');
    assert(after.sync.val === undefined,
      `value must stop flowing when no viewer wants mirroring, got ${JSON.stringify(after.sync)}`);
  } finally {
    plain.close();
  }
});

test('alert() blocks until the user acknowledges it', async ({ cdp, page }) => {
  await focusPage(cdp, page);
  const viewer = await Viewer.open();
  try {
    await cdp.eval(page.sessionId, `window.__ack = null; 1`);
    cdp.evalNoWait(page.sessionId, `(function(){ var t = Date.now(); alert('integration'); window.__ack = Date.now() - t; })()`);
    const d = await viewer.waitForDialog((d) => d.open && d.type === 'alert', 10000, 'the alert sheet');
    assertEq(d.notify, false, 'an alert with a viewer attached is a QUESTION, not a notification');
    // No "is it blocked?" eval here: while the dialog is up, Runtime.evaluate itself
    // blocks, so it could only ever answer after the fact. The elapsed time below is
    // the real proof, and it is measured inside the page.

    await sleep(1200); // stand in for a human reading it
    viewer.send({ dialogReply: { seq: d.seq, accept: true, text: '', notify: false, bridge: false } });
    await viewer.waitFor((f) => f.dialog && f.dialog.open === false, 8000, 'the close broadcast');
    const took = await cdp.eval(page.sessionId, `window.__ack`);
    assert(typeof took === 'number' && took > 900,
      `alert() must return only after the tap; it took ${took}ms (the old auto-accept was ~18ms)`);
  } finally {
    viewer.close();
    await sleep(300);
  }
});

test('alert() with no viewer attached is accepted at once', async ({ cdp, page }) => {
  // No Viewer.open() here — and the harness holds no other /kbd socket.
  await cdp.eval(page.sessionId, `window.__ack2 = null; 1`);
  cdp.evalNoWait(page.sessionId, `(function(){ var t = Date.now(); alert('unattended'); window.__ack2 = Date.now() - t; })()`);
  await sleep(1800);
  const took = await cdp.eval(page.sessionId, `window.__ack2`);
  assert(typeof took === 'number' && took < 1200,
    `with no viewer attached an alert must be accepted at once, got ${took}ms. ` +
    `A value near ${'15s'} means the 15s backstop fired instead, i.e. a viewer IS ` +
    `connected — close any open liveview tab and rerun.`);
});

// The liveness backstop. A viewer that goes away mid-alert (or a page firing them in
// a loop) must not be able to freeze the page for the rest of the session.
test('an unacknowledged alert is accepted after the backstop', async ({ cdp, page }) => {
  await focusPage(cdp, page);
  const viewer = await Viewer.open();
  try {
    await cdp.eval(page.sessionId, `window.__ack3 = null; 1`);
    cdp.evalNoWait(page.sessionId, `(function(){ var t = Date.now(); alert('ignored'); window.__ack3 = Date.now() - t; })()`);
    await viewer.waitForDialog((d) => d.open && d.type === 'alert', 10000, 'the alert sheet');
    // Deliberately never reply.
    await sleep(18000);
    const took = await cdp.eval(page.sessionId, `window.__ack3`);
    assert(typeof took === 'number', 'the page must not stay blocked forever on an unanswered alert');
    assert(took > 12000 && took < 18000,
      `expected the ~15s backstop to release it, got ${took}ms`);
  } finally {
    viewer.close();
    await sleep(300);
  }
});

test('a stale dialog reply cannot clear a newer sheet', async ({ cdp, page }) => {
  const viewer = await Viewer.open();
  try {
    // First dialog: answered normally.
    cdp.evalNoWait(page.sessionId, `setTimeout(function(){ window.__c1 = confirm('first'); }, 0)`);
    const d1 = await viewer.waitForDialog((d) => d.open && d.type === 'confirm', 10000, 'the first confirm');
    viewer.send({ dialogReply: { seq: d1.seq, accept: true, text: '', notify: false, bridge: false } });
    await viewer.waitFor((f) => f.dialog && f.dialog.open === false, 8000, 'the first close');
    await sleep(300);

    // Second dialog, then the STALE reply for the first one lands late.
    viewer.clear();
    cdp.evalNoWait(page.sessionId, `setTimeout(function(){ window.__c2 = confirm('second'); }, 0)`);
    const d2 = await viewer.waitForDialog((d) => d.open && d.type === 'confirm', 10000, 'the second confirm');
    assert(d2.seq !== d1.seq, 'the second dialog must have its own sequence number');
    viewer.clear();
    viewer.send({ dialogReply: { seq: d1.seq, accept: true, text: '', notify: false, bridge: false } });
    await sleep(1200);
    assert(!viewer.frames.some((f) => f.dialog && f.dialog.open === false),
      'the stale reply must NOT clear the newer sheet');

    // And the newer one is still answerable.
    viewer.send({ dialogReply: { seq: d2.seq, accept: false, text: '', notify: false, bridge: false } });
    await viewer.waitFor((f) => f.dialog && f.dialog.open === false, 8000, 'the second close');
    assertEq(await cdp.eval(page.sessionId, `window.__c2`), false, 'the dismiss reached the page');
  } finally {
    viewer.close();
    await sleep(300);
  }
});

test('two targets can block on their own dialogs at once', async ({ cdp, page }) => {
  const viewer = await Viewer.open();
  const second = await cdp.newPage(`http://${HOSTGW}:8099/?second=1`);
  try {
    await sleep(600);
    cdp.evalNoWait(page.sessionId, `setTimeout(function(){ window.__a = confirm('page A'); }, 0)`);
    const dA = await viewer.waitForDialog((d) => d.open, 10000, "page A's dialog");
    cdp.evalNoWait(second.sessionId, `setTimeout(function(){ window.__b = confirm('page B'); }, 0)`);
    const dB = await viewer.waitForDialog((d) => d.open && d.seq !== dA.seq, 10000, "page B's dialog");

    // Answer B; A is still blocked, so its state has to come BACK (the viewer holds
    // one sheet, so a close with nothing republished would hide a blocked page).
    viewer.clear();
    viewer.send({ dialogReply: { seq: dB.seq, accept: true, text: '', notify: false, bridge: false } });
    const back = await viewer.waitForDialog((d) => d.open && d.seq === dA.seq, 8000,
      "page A's dialog to be republished");
    assert(back, 'A must be re-shown');
    assertEq(await cdp.eval(second.sessionId, `window.__b`), true, "B's answer reached page B");

    // A is still answerable on its own session.
    viewer.send({ dialogReply: { seq: dA.seq, accept: false, text: '', notify: false, bridge: false } });
    await sleep(800);
    assertEq(await cdp.eval(page.sessionId, `window.__a`), false, "A's answer reached page A");
  } finally {
    viewer.close();
    await cdp.send('Target.closeTarget', { targetId: second.targetId }).catch(() => {});
    await sleep(500);
  }
});

test('a popup is advertised and the viewer can close it', async ({ cdp, page }) => {
  const viewer = await Viewer.open();
  try {
    const idsBefore = new Set((await cdp.pageTargets()).map((t) => t.targetId));
    await cdp.eval(page.sessionId, `!!window.open('http://${HOSTGW}:8100/', 'pop', 'width=500,height=600')`);
    await sleep(1200);
    const popupId = (await cdp.pageTargets()).map((t) => t.targetId).find((t) => !idsBefore.has(t));
    assert(popupId, 'the popup window was never created');
    // The popup has to be the FOREGROUND window for the affordance to point at it —
    // which is the whole rule under test. (This harness page is itself a second page,
    // so whatever holds focus is what gets offered.)
    await viewer.waitForPopup((p) => p.open, 10000, 'the popup advertisement');
    await cdp.send('Target.activateTarget', { targetId: popupId });
    await sleep(1200);
    // Read the CURRENT advertisement after activation: the front window may have
    // moved (bumping the sequence), and a stale seq is correctly refused.
    const p = viewer.latestPopup();
    assert(p && p.open, `no live popup advertisement, got ${JSON.stringify(p)}`);
    assert(p.seq > 0, `the advertisement must carry a sequence number, got ${JSON.stringify(p)}`);

    const before = (await cdp.pageTargets()).length;
    viewer.clear();
    viewer.send({ popupClose: { seq: p.seq } });
    await sleep(1500);
    const after = await cdp.pageTargets();
    assertEq(after.length, before - 1, 'the advertised window must actually close');
    assert(!after.some((t) => t.targetId === popupId),
      'the window that closed must be the popup we opened, not another page');
    // The advertisement must CHANGE. Not necessarily to open:false — this harness
    // keeps its own page open, so another window is still closable; what matters is
    // that the stale sequence number is retired.
    const next = await viewer.waitForPopup(() => true, 8000, 'the republished popup state');
    assert(next.open === false || next.seq !== p.seq,
      `the closed window's sequence must be retired, still ${JSON.stringify(next)}`);
  } finally {
    viewer.close();
    await sleep(300);
  }
});

test('a stale popup-close sequence is ignored', async ({ cdp, page }) => {
  const viewer = await Viewer.open();
  try {
    await cdp.eval(page.sessionId, `!!window.open('http://${HOSTGW}:8100/', 'pop2', 'width=500,height=600')`);
    const p = await viewer.waitForPopup((p) => p.open, 10000, 'the popup advertisement');
    const before = (await cdp.pageTargets()).length;
    viewer.send({ popupClose: { seq: p.seq + 99 } });
    await sleep(1000);
    assertEq((await cdp.pageTargets()).length, before, 'a stale sequence must close nothing');
    viewer.send({ popupClose: { seq: p.seq } }); // clean up
    await sleep(1000);
  } finally {
    viewer.close();
    await sleep(300);
  }
});

test('a touch gesture always delivers its terminal event', async ({ cdp, page }) => {
  // Touch emulation on (magnify), and this page is the active one.
  await fetch(`${NOVNC}/emulate`, {
    method: 'POST',
    body: JSON.stringify({ width: 390, height: 844, deviceScaleFactor: 2, mobile: false, touch: true }),
  });
  await sleep(700);
  await focusPage(cdp, page);
  await cdp.eval(page.sessionId, `
    window.__ev = [];
    ['touchstart','touchmove','touchend','touchcancel'].forEach(function (t) {
      document.addEventListener(t, function () { window.__ev.push(t); }, true);
    }); 1`);

  const ws = new WebSocket(`${NOVNC.replace('http', 'ws')}/input`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  try {
    // Deliberately ABOVE the cross-origin iframe on this page (it starts at y=220):
    // a touch inside it is delivered to the child document, whose listeners are not
    // the ones registered here — which looks exactly like a dropped gesture.
    ws.send(JSON.stringify({ t: 'start', points: [{ x: 200, y: 120 }] }));
    for (let i = 0; i < 400; i++) { // flood: this is what used to crowd out the end
      ws.send(JSON.stringify({ t: 'move', points: [{ x: 200, y: 120 + (i % 40) }] }));
    }
    ws.send(JSON.stringify({ t: 'end', points: [] }));
    await sleep(2500);
    const ev = await cdp.eval(page.sessionId, `JSON.stringify(window.__ev)`);
    const seen = JSON.parse(ev);
    assert(seen.includes('touchstart'), `no touchstart reached the page (${seen.length} events)`);
    assert(seen.includes('touchend') || seen.includes('touchcancel'),
      `the gesture never terminated: ${JSON.stringify(seen.slice(0, 5))}...${JSON.stringify(seen.slice(-5))}`);
  } finally {
    try { ws.close(); } catch (_) {}
    await fetch(`${NOVNC}/emulate`, {
      method: 'POST',
      body: JSON.stringify({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false }),
    });
    await sleep(500);
  }
});

test('a field in a cross-origin iframe is positioned in TOP coordinates', async ({ cdp, page }) => {
  const parent = await cdp.newPage(`http://${HOSTGW}:8099/`);
  const viewer = await Viewer.open();
  try {
    await focusPage(cdp, parent);
    const box = JSON.parse(await cdp.eval(parent.sessionId, `(function(){
      var f = document.getElementById('kid'); var r = f.getBoundingClientRect();
      return JSON.stringify({x: Math.round(r.left), y: Math.round(r.top)});
    })()`));

    // Reach the child's PAGE WORLD. A different PORT is a different origin (which is
    // what content.js's relay turns on) but the same SITE, so Chrome keeps it in
    // process and there is no iframe target to attach to — its execution context is
    // the way in.
    const kidCtx = await parent.contextFor(`:8100`);
    viewer.clear();
    await cdp.evalIn(parent.sessionId, kidCtx, `document.getElementById('ci').focus(); 1`);

    const s = await viewer.waitFor((f) => f.editable === true && f.rect, 12000, 'the cross-frame editable state');
    // The child's input sits at (20, 60) inside the iframe.
    const wantX = box.x + 20, wantY = box.y + 60;
    assert(Math.abs(s.rect.x - wantX) <= 4 && Math.abs(s.rect.y - wantY) <= 4,
      `rect ${JSON.stringify(s.rect)} is not the child's input in top coords (want ~${wantX},${wantY}) ` +
      `— the offset relay is wrong, which is the mispositioned keyboard lift`);

    // Now the forgery: the child's PAGE world posts the old bubbled-state shape and a
    // bogus position. Neither may be adopted.
    viewer.clear();
    await cdp.evalIn(parent.sessionId, kidCtx, `window.__forge(); 1`);
    await sleep(1500);
    const forged = viewer.states().find((f) => (f.rect && f.rect.w === 99) ||
      (Array.isArray(f.rects) && f.rects.some((r) => r.w === 99)) ||
      (f.sync && f.sync.val === 'forged') || f.focusKey === 'forged');
    assert(!forged, `a page-forged focus state was relayed as trusted: ${JSON.stringify(forged)}`);
    const moved = viewer.states().find((f) => f.rect && f.rect.y > 90000);
    assert(!moved, 'a page-forged position was accepted');
  } finally {
    viewer.close();
    await cdp.send('Target.closeTarget', { targetId: parent.targetId }).catch(() => {});
    // Closing the foreground cross-origin test tab does not reliably emit a
    // focus transition for the shared page. Restore it explicitly so the next
    // extension descriptor is attributed to the active tab rather than timing
    // out against a stale background-worker tab id.
    await focusPage(cdp, page);
  }
});

test('the select picker refuses options a native control forbids', async ({ cdp, page }) => {
  // The shim only engages under touch emulation (that is its "magnify is on" signal).
  await fetch(`${NOVNC}/emulate`, {
    method: 'POST',
    body: JSON.stringify({ width: 390, height: 844, deviceScaleFactor: 2, mobile: false, touch: true }),
  });
  await sleep(700);
  try {
    const out = JSON.parse(await cdp.eval(page.sessionId, `(function(){
      var old = document.getElementById('sel'); if (old) old.remove();
      var s = document.createElement('select'); s.id = 'sel';
      s.innerHTML = '<option value="a">alpha</option>' +
        '<optgroup label="blocked" disabled><option value="b">bravo</option></optgroup>' +
        '<option value="c" disabled>charlie</option>' +
        '<option value="d" hidden>delta</option>' +
        '<optgroup label="gone" hidden><option value="e">echo</option></optgroup>' +
        '<option value="f">foxtrot</option>';
      document.body.appendChild(s);
      s.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
      var sheet = document.getElementById('__pcn_select_sheet');
      if (!sheet) return JSON.stringify({sheet: false});
      var rows = [].map.call(sheet.querySelectorAll('.pcn_opt'), function (r) {
        return {text: (r.textContent || '').trim(), dis: r.className.indexOf('pcn_dis') >= 0, idx: r.dataset.idx};
      });
      return JSON.stringify({sheet: true, rows: rows});
    })()`));
    assert(out.sheet, 'the custom picker did not open (touch emulation not applied?)');
    const byText = (t) => out.rows.find((r) => r.text.startsWith(t));
    assert(byText('alpha') && byText('alpha').idx !== undefined, 'a normal option stays selectable');
    assert(byText('foxtrot'), 'a normal option after the groups is rendered');
    const bravo = byText('bravo');
    assert(bravo, 'an option in a disabled group is still listed');
    assert(bravo.dis && bravo.idx === undefined, 'an option inside <optgroup disabled> must not be selectable');
    assert(byText('charlie').dis, 'a disabled option must not be selectable');
    assert(!byText('delta'), 'a hidden option must not be rendered');
    assert(!byText('echo'), 'options in a hidden optgroup must not be rendered');
  } finally {
    await cdp.eval(page.sessionId, `(function(){var s=document.getElementById('sel'); if(s) s.remove();
      var sh=document.getElementById('__pcn_select_sheet'); if(sh) sh.remove();})()`).catch(() => {});
    await fetch(`${NOVNC}/emulate`, {
      method: 'POST',
      body: JSON.stringify({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false }),
    });
    await sleep(400);
  }
});

test('native select descriptors and choices round-trip through the extension', async ({ cdp, page }) => {
  await focusPage(cdp, page);
  const viewer = await Viewer.open();
  try {
    viewer.clear();
    await cdp.eval(page.sessionId, `(function(){
      var old = document.getElementById('native-proxy-select'); if (old) old.remove();
      var s = document.createElement('select'); s.id = 'native-proxy-select';
      s.setAttribute('aria-label', 'Account type');
      s.style.cssText = 'position:absolute;left:44px;top:96px;width:240px;height:58px';
      s.innerHTML = '<option>Personal</option><option>Business</option><option disabled>Blocked</option>';
      window.__selectEvents = [];
      s.addEventListener('input', function(){ window.__selectEvents.push('input:' + s.selectedIndex); });
      s.addEventListener('change', function(){ window.__selectEvents.push('change:' + s.selectedIndex); });
      document.body.appendChild(s); return 1;
    })()`);
    const state = await viewer.waitFor((f) => f.editable === false && Array.isArray(f.selects) &&
      f.selects.some((s) => s.a === 'Account type'), 12000, 'a native select descriptor');
    const descriptor = state.selects.find((s) => s.a === 'Account type');
    assert(descriptor.k && descriptor.r && descriptor.o.length === 3,
      `bad descriptor: ${JSON.stringify(descriptor)}`);
    assertEq(descriptor.s, 0, 'initial selected index');
    assertEq(descriptor.o[1].t, 'Business', 'option label');
    assertEq(descriptor.o[2].d, true, 'disabled option metadata');

    // A static page sends no mutation/scroll/focus report after this descriptor.
    // The offered local picker must still be committable after the frame-cache
    // freshness window, because the background continues to advertise it.
    await sleep(6500);
    viewer.send({ selectChoice: { key: descriptor.k, index: 1 } });
    const deadline = Date.now() + 8000;
    let result;
    do {
      result = JSON.parse(await cdp.eval(page.sessionId,
        `JSON.stringify({index:document.getElementById('native-proxy-select').selectedIndex,events:window.__selectEvents})`));
      if (result.index === 1 && result.events.length >= 2) break;
      await sleep(100);
    } while (Date.now() < deadline);
    assertEq(result.index, 1, 'viewer choice reached the remote select');
    assertEq(result.events.join(','), 'input:1,change:1', 'native input/change semantics');

    viewer.send({ selectChoice: { key: descriptor.k, index: 2 } });
    await sleep(500);
    assertEq(await cdp.eval(page.sessionId, `document.getElementById('native-proxy-select').selectedIndex`), 1,
      'disabled option is rejected at commit time');
  } finally {
    viewer.close();
    await cdp.eval(page.sessionId, `(function(){var s=document.getElementById('native-proxy-select');if(s)s.remove();})()`).catch(() => {});
    await sleep(300);
  }
});

test('a 195-option country select stays native and commits its final option', async ({ cdp, page }) => {
  await focusPage(cdp, page);
  const viewer = await Viewer.open();
  try {
    viewer.clear();
    await cdp.eval(page.sessionId, `(function(){
      var old = document.getElementById('native-country-select'); if (old) old.remove();
      var s = document.createElement('select'); s.id = 'native-country-select';
      s.setAttribute('aria-label', 'Country');
      s.style.cssText = 'position:absolute;left:44px;top:180px;width:300px;height:58px';
      for (var i = 0; i < 195; i++) {
        var o = document.createElement('option');
        o.textContent = i === 194 ? 'Zimbabwe' : 'Country ' + String(i + 1).padStart(3, '0');
        s.appendChild(o);
      }
      window.__countrySelectEvents = [];
      s.addEventListener('input', function(){ window.__countrySelectEvents.push('input:' + s.selectedIndex); });
      s.addEventListener('change', function(){ window.__countrySelectEvents.push('change:' + s.selectedIndex); });
      document.body.appendChild(s); return s.options.length;
    })()`);
    const state = await viewer.waitFor((f) => f.editable === false && Array.isArray(f.selects) &&
      f.selects.some((s) => s.a === 'Country' && s.o.length === 195), 12000, 'a 195-option native select descriptor');
    const descriptor = state.selects.find((s) => s.a === 'Country');
    assertEq(descriptor.o.length, 195, 'all country options cross the /kbd channel');
    assertEq(descriptor.o[194].t, 'Zimbabwe', 'the final country is not truncated');
    assert(new TextEncoder().encode(JSON.stringify(state)).length < 24000,
      'country descriptor must stay inside the merged wire budget');

    viewer.send({ selectChoice: { key: descriptor.k, index: 194 } });
    const deadline = Date.now() + 8000;
    let result;
    do {
      result = JSON.parse(await cdp.eval(page.sessionId,
        `JSON.stringify({index:document.getElementById('native-country-select').selectedIndex,events:window.__countrySelectEvents})`));
      if (result.index === 194 && result.events.length >= 2) break;
      await sleep(100);
    } while (Date.now() < deadline);
    assertEq(result.index, 194, 'last country choice reached the remote select');
    assertEq(result.events.join(','), 'input:194,change:194', 'long native select input/change semantics');
  } finally {
    viewer.close();
    await cdp.eval(page.sessionId,
      `(function(){var s=document.getElementById('native-country-select');if(s)s.remove();})()`).catch(() => {});
    await sleep(300);
  }
});

test('native date descriptor and value round-trip through the extension', async ({ cdp, page }) => {
  await focusPage(cdp, page);
  const viewer = await Viewer.open();
  try {
    viewer.clear();
    await cdp.eval(page.sessionId, `(function(){
      var old = document.getElementById('native-date-input'); if (old) old.remove();
      var input = document.createElement('input'); input.id = 'native-date-input'; input.type = 'date';
      input.value = '2026-08-21'; input.min = '2026-08-01'; input.max = '2026-08-31'; input.step = '1';
      input.setAttribute('aria-label', 'Travel date');
      input.style.cssText = 'position:absolute;left:44px;top:260px;width:300px;height:58px';
      window.__dateEvents = [];
      input.addEventListener('input', function(){ window.__dateEvents.push('input:' + input.value); });
      input.addEventListener('change', function(){ window.__dateEvents.push('change:' + input.value); });
      document.body.appendChild(input); return 1;
    })()`);
    const state = await viewer.waitFor((f) => f.editable === false && Array.isArray(f.pickers) &&
      f.pickers.some((p) => p.a === 'Travel date'), 12000, 'a native date descriptor');
    const descriptor = state.pickers.find((p) => p.a === 'Travel date');
    assertEq(descriptor.t, 'date', 'picker type');
    assertEq(descriptor.v, '2026-08-21', 'initial date');
    assertEq(descriptor.min, '2026-08-01', 'minimum date');
    assertEq(descriptor.max, '2026-08-31', 'maximum date');

    viewer.send({ pickerChoice: { key: descriptor.k, value: '2026-08-22' } });
    const deadline = Date.now() + 8000;
    let result;
    do {
      result = JSON.parse(await cdp.eval(page.sessionId,
        `JSON.stringify({value:document.getElementById('native-date-input').value,events:window.__dateEvents})`));
      if (result.value === '2026-08-22' && result.events.length >= 2) break;
      await sleep(100);
    } while (Date.now() < deadline);
    assertEq(result.value, '2026-08-22', 'viewer date reached the remote input');
    assertEq(result.events.join(','),
      'input:2026-08-22,change:2026-08-22', 'native date input/change semantics');

    viewer.send({ pickerChoice: { key: descriptor.k, value: '2026-09-01' } });
    await sleep(500);
    assertEq(await cdp.eval(page.sessionId, `document.getElementById('native-date-input').value`), '2026-08-22',
      'out-of-range date is rejected at commit time');
  } finally {
    viewer.close();
    await cdp.eval(page.sessionId,
      `(function(){var input=document.getElementById('native-date-input');if(input)input.remove();})()`).catch(() => {});
    await sleep(300);
  }
});

test('remaining native temporal descriptors and values round-trip through the extension', async ({ cdp, page }) => {
  await focusPage(cdp, page);
  const viewer = await Viewer.open();
  const specs = [
    { type: 'time', label: 'Meeting time', initial: '10:15', min: '09:00', max: '17:00', next: '11:30', bad: '18:00' },
    { type: 'datetime-local', label: 'Local appointment', initial: '2026-08-23T10:15', min: '2026-08-20T09:00', max: '2026-08-30T17:00', next: '2026-08-24T11:30', bad: '2026-09-01T10:00' },
    { type: 'month', label: 'Billing month', initial: '2026-08', min: '2026-01', max: '2026-12', next: '2026-09', bad: '2027-01' },
    { type: 'week', label: 'Delivery week', initial: '2026-W34', min: '2026-W30', max: '2026-W39', next: '2026-W35', bad: '2026-W40' },
  ];
  try {
    viewer.clear();
    await cdp.eval(page.sessionId, `(function(){
      document.querySelectorAll('[data-native-temporal-test]').forEach(function(el){ el.remove(); });
      window.__temporalEvents = {};
      var specs = ${JSON.stringify(specs)};
      specs.forEach(function(s, i){
        var input = document.createElement('input');
        input.dataset.nativeTemporalTest = '1'; input.id = 'native-temporal-' + i; input.type = s.type;
        input.value = s.initial; input.min = s.min; input.max = s.max; input.step = '1'; input.required = true;
        input.setAttribute('aria-label', s.label);
        input.style.cssText = 'position:absolute;left:44px;top:' + (180 + i * 72) + 'px;width:300px;height:58px';
        window.__temporalEvents[s.type] = [];
        input.addEventListener('input', function(){ window.__temporalEvents[s.type].push('input:' + input.value); });
        input.addEventListener('change', function(){ window.__temporalEvents[s.type].push('change:' + input.value); });
        document.body.appendChild(input);
      });
      return 1;
    })()`);
    const state = await viewer.waitFor((f) => f.editable === false && Array.isArray(f.pickers) &&
      specs.every((s) => f.pickers.some((p) => p.a === s.label)), 12000, 'all temporal picker descriptors');
    for (const spec of specs) {
      const descriptor = state.pickers.find((p) => p.a === spec.label);
      assertEq(descriptor.t, spec.type, `${spec.type} picker type`);
      assertEq(descriptor.v, spec.initial, `${spec.type} initial value`);
      assertEq(descriptor.min, spec.min, `${spec.type} minimum`);
      assertEq(descriptor.max, spec.max, `${spec.type} maximum`);
      assertEq(descriptor.req, true, `${spec.type} required flag`);

      viewer.send({ pickerChoice: { key: descriptor.k, value: spec.next } });
      const deadline = Date.now() + 8000;
      let result;
      do {
        result = JSON.parse(await cdp.eval(page.sessionId, `(function(){
          var input = Array.from(document.querySelectorAll('[data-native-temporal-test]')).find(function(el){ return el.type === ${JSON.stringify(spec.type)}; });
          return JSON.stringify({value:input && input.value,events:window.__temporalEvents[${JSON.stringify(spec.type)}]});
        })()`));
        if (result.value === spec.next && result.events.length >= 2) break;
        await sleep(100);
      } while (Date.now() < deadline);
      assertEq(result.value, spec.next, `${spec.type} choice reached the remote input`);
      assertEq(result.events.join(','), `input:${spec.next},change:${spec.next}`, `${spec.type} input/change semantics`);

      viewer.send({ pickerChoice: { key: descriptor.k, value: spec.bad } });
      await sleep(300);
      const valueAfterBad = await cdp.eval(page.sessionId, `(function(){
        var input = Array.from(document.querySelectorAll('[data-native-temporal-test]')).find(function(el){ return el.type === ${JSON.stringify(spec.type)}; });
        return input && input.value;
      })()`);
      assertEq(valueAfterBad, spec.next, `${spec.type} out-of-range value is rejected`);
    }
  } finally {
    viewer.close();
    await cdp.eval(page.sessionId,
      `(function(){document.querySelectorAll('[data-native-temporal-test]').forEach(function(el){el.remove();});})()`).catch(() => {});
    await sleep(300);
  }
});

// ---------------------------------------------------------------------------
const PARENT_HTML = `<!doctype html><title>parent</title>
<body style="margin:0"><h1>parent</h1>
<input id="pi" style="width:300px">
<div style="height:80px"></div>
<iframe id="kid" src="http://HOSTGW:8100/" style="position:absolute;left:60px;top:220px;width:400px;height:200px;border:0"></iframe>`;

async function main() {
  const servers = [
    await serve(8099, PARENT_HTML.replace('HOSTGW', HOSTGW)),
    await serve(8100, CHILD_HTML),
  ];
  const cdp = await Cdp.open();
  let page;
  let failed = 0, passed = 0, skipped = 0;
  try {
    // Leftovers from an earlier run change what "the front window" means, so clear
    // our own pages out first (never the container's start page).
    for (const t of await cdp.pageTargets()) {
      if (t.url.includes(HOSTGW) || t.url === 'about:blank') {
        await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      }
    }
    await sleep(600);
    console.log(`  ..   ${(await cdp.pageTargets()).length} page target(s) before the suite`);
    page = await cdp.newPage(`http://${HOSTGW}:8099/`);
    // Prove the container can reach us and the extension injected here; every
    // page-world test depends on both.
    const title = await cdp.eval(page.sessionId, `document.title`);
    assertEq(title, 'parent', `the container cannot load http://${HOSTGW}:8099/ — set HOSTGW`);

    for (const t of tests) {
      if (ONLY && !t.name.includes(ONLY)) { skipped++; continue; }
      // The preceding dialog/popup/cross-origin cases deliberately create,
      // activate, and destroy several page targets. Chromium can keep the
      // original shared document `hasFocus()`-true while its extension frame
      // cache still belongs to a destroyed foreground target. Native-control
      // tests need a clean document identity, not state leaked from those window
      // lifecycle tests, so establish the isolation boundary once here.
      if (t.name === 'native select descriptors and choices round-trip through the extension') {
        await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
        page = await cdp.newPage(`http://${HOSTGW}:8099/`);
        await focusPage(cdp, page);
      }
      const started = Date.now();
      try {
        await t.fn({ cdp, page });
        passed++;
        console.log(`  ok   ${t.name}  (${Date.now() - started}ms)`);
      } catch (err) {
        failed++;
        console.log(`  FAIL ${t.name}  (${Date.now() - started}ms)\n       ${err.message}`);
      }
      // A test that lost the page (a stray close, a crash) must not fail every test
      // after it — rebuild before moving on.
      const alive = await cdp.eval(page.sessionId, '1').then(() => true).catch(() => false);
      if (!alive) {
        console.log('       (test page was lost; recreating)');
        page = await cdp.newPage(`http://${HOSTGW}:8099/`);
      }
    }
  } finally {
    if (page) await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    cdp.close();
    for (const s of servers) s.close();
  }
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
