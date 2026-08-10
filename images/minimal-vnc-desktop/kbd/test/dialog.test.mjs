// dialog.test.mjs — characterization: the JS dialog sheet (kbd/dialog.js).
//
// Chromium lays alert()/confirm()/prompt() out against the real browser window,
// so under a narrow mobile emulation the dialog overflows and its OK button can
// be off-screen — and a dialog blocks script execution, so that wedges the page.
// The proxy intercepts it and we draw it here instead. These pin the reply
// contract (what the proxy turns into Page.handleJavaScriptDialog) and the
// per-type button semantics, which are what make the sheet answerable at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

installGlobals('android-input');
const { createDialog } = await import('../dialog.js');

function harness() {
  const sent = [];
  const d = createDialog({ sendReply: (r) => sent.push(r) });
  return { d, sent };
}
// The sheet is built with createElement, so walk it for buttons by label.
function buttons(el, found = []) {
  if (!el) return found;
  if (el.tagName === 'BUTTON') found.push(el);
  (el.children || []).forEach((c) => buttons(c, found));
  return found;
}
function allText(el, out = []) {
  if (!el) return out;
  if (el.textContent) out.push(el.textContent);
  (el.children || []).forEach((c) => allText(c, out));
  return out;
}
function labels(d) { return buttons(d._root()).map((b) => b.textContent); }

test('an alert offers only OK — the page never gave a choice to cancel', () => {
  const { d } = harness();
  d.apply({ open: true, seq: 1, type: 'alert', message: 'Please Enter Valid UAN', url: 'https://passbook.epfindia.gov.in/x?token=secret' });
  assert.deepEqual(labels(d), ['OK']);
});

test('OK answers with accept=true and the dialog seq', () => {
  const { d, sent } = harness();
  d.apply({ open: true, seq: 7, type: 'alert', message: 'hi', url: 'https://e.gov.in/' });
  buttons(d._root()).find((b) => b.textContent === 'OK').onclick();
  assert.deepEqual(sent, [{ seq: 7, accept: true, text: '', notify: false, bridge: false }]);
});

test('a confirm offers Cancel, which answers accept=false', () => {
  const { d, sent } = harness();
  d.apply({ open: true, seq: 2, type: 'confirm', message: 'Sure?', url: 'https://e.gov.in/' });
  assert.deepEqual(labels(d), ['Cancel', 'OK']);
  buttons(d._root()).find((b) => b.textContent === 'Cancel').onclick();
  assert.deepEqual(sent, [{ seq: 2, accept: false, text: '', notify: false, bridge: false }]);
});

test('a prompt returns its text, seeded from defaultPrompt', () => {
  const { d, sent } = harness();
  d.apply({ open: true, seq: 3, type: 'prompt', message: 'Name?', defaultPrompt: 'abc', url: 'https://e.gov.in/' });
  buttons(d._root()).find((b) => b.textContent === 'OK').onclick();
  assert.deepEqual(sent, [{ seq: 3, accept: true, text: 'abc', notify: false, bridge: false }]);
});

test('beforeunload says Leave/Stay — OK/Cancel would risk losing form data', () => {
  const { d } = harness();
  d.apply({ open: true, seq: 4, type: 'beforeunload', message: '', url: 'https://e.gov.in/' });
  assert.deepEqual(labels(d), ['Stay', 'Leave']);
});

test('open:false takes the sheet down', () => {
  const { d } = harness();
  d.apply({ open: true, seq: 5, type: 'alert', message: 'x', url: 'https://e.gov.in/' });
  assert.equal(d.shown(), true);
  d.apply({ open: false });
  assert.equal(d.shown(), false);
});

test('a repeated frame for the SAME dialog does not rebuild the sheet', () => {
  // The hub resyncs late joiners and coalesces, so the same state can arrive
  // twice; rebuilding would wipe half-typed prompt text.
  const { d } = harness();
  d.apply({ open: true, seq: 6, type: 'prompt', message: 'Name?', url: 'https://e.gov.in/' });
  const before = d._root();
  d.apply({ open: true, seq: 6, type: 'prompt', message: 'Name?', url: 'https://e.gov.in/' });
  assert.equal(d._root(), before);
});

test('the URL query is never rendered — only the origin', () => {
  // Dialog URLs routinely carry tokens, and this text ends up on screen.
  const { d } = harness();
  d.apply({ open: true, seq: 8, type: 'alert', message: 'x', url: 'https://passbook.epfindia.gov.in/p?token=SECRET' });
  const text = allText(d._root()).join(' ');
  assert.equal(/SECRET/.test(text), false, 'no query string on screen');
  assert.equal(/passbook\.epfindia\.gov\.in says/.test(text), true, 'origin still attributed');
});

// ---- notification alerts -----------------------------------------------------
// Page.javascriptDialogOpening does NOT suppress Chromium's own dialog, so a
// forwarded dialog is drawn twice (native + ours). alert() has no return value,
// so the proxy accepts it natively at once — removing it from the stream and
// unblocking the page — and flags ours notify:true. Tapping OK then only closes
// our sheet, but must STILL reply, because that reply is what clears the hub's
// resync cache for viewers connecting later.

test('a notify alert still replies, so the hub stops resyncing it', () => {
  const { d, sent } = harness();
  d.apply({ open: true, seq: 9, type: 'alert', notify: true, message: 'Please Enter Valid UAN', url: 'https://e.gov.in/' });
  buttons(d._root()).find((b) => b.textContent === 'OK').onclick();
  assert.deepEqual(sent, [{ seq: 9, accept: true, text: '', notify: true, bridge: false }]);
  assert.equal(d.shown(), false);
});

test('a blocking dialog is not flagged notify — its answer is load-bearing', () => {
  const { d, sent } = harness();
  d.apply({ open: true, seq: 10, type: 'confirm', message: 'Sure?', url: 'https://e.gov.in/' });
  buttons(d._root()).find((b) => b.textContent === 'OK').onclick();
  assert.deepEqual(sent, [{ seq: 10, accept: true, text: '', notify: false, bridge: false }]);
});

// ---- the sheet must actually be clickable ------------------------------------
// REGRESSION: the first version swallowed events in the CAPTURE phase on the
// wrapper to keep gestures off the stream. Capture on an ancestor runs before the
// target, so it stopped events reaching our own OK button — the sheet rendered and
// could not be dismissed, leaving the user stuck. It also protected nothing: the
// stream's handlers are capture-on-document (tap.js) and run first regardless.
// These tests dispatch through the real listener path; asserting on .onclick()
// directly is exactly what let the bug through.

test('a click dispatched at the OK button reaches it through the wrapper', () => {
  const { d, sent } = harness();
  d.apply({ open: true, seq: 20, type: 'alert', notify: true, message: 'x', url: 'https://e.gov.in/' });
  const ok = buttons(d._root()).find((b) => b.textContent === 'OK');
  // Walk the wrapper's own capture listeners the way the DOM would, then fire the
  // target handler. If an ancestor stops propagation, `stopped` flips and the
  // button never runs — the shipped bug.
  let stopped = false;
  const evt = { type: 'click', target: ok, stopPropagation() { stopped = true; } };
  (d._root()._listeners.click || []).forEach((fn) => fn(evt));
  assert.equal(stopped, false, 'the wrapper must not swallow clicks aimed at its own buttons');
  ok.onclick(evt);
  assert.equal(sent.length, 1, 'OK answered the dialog');
});

test('the sheet claims its own targets so a tap is not ALSO sent to the remote', () => {
  // tap.js consults owns() the way it already consults onMagButton; without it a
  // tap on the sheet would additionally be dispatched as a remote touch.
  const { d } = harness();
  d.apply({ open: true, seq: 21, type: 'alert', message: 'x', url: 'https://e.gov.in/' });
  const ok = buttons(d._root()).find((b) => b.textContent === 'OK');
  assert.equal(d.owns(ok), true);
  assert.equal(d.owns(d._root()), true);
  assert.equal(d.owns(globalThis.document.createElement('div')), false, 'unrelated targets are not ours');
});

test('owns() is false once the sheet is down, so taps go back to the stream', () => {
  const { d } = harness();
  d.apply({ open: true, seq: 22, type: 'alert', message: 'x', url: 'https://e.gov.in/' });
  const ok = buttons(d._root()).find((b) => b.textContent === 'OK');
  d.apply({ open: false });
  assert.equal(d.owns(ok), false);
});

// ---- FedCM account chooser ---------------------------------------------------
// FedCM's chooser is browser UI, so at 412px the Continue button is clipped off
// screen — and it is the ONLY way through, which makes Google sign-in impossible on
// mobile. There is no styling route (branding belongs to the IdP, not to us), so we
// render our own and relay the pick via FedCm.selectAccount. Our sheet is a remote
// control for Chrome's dialog, not a replacement: Chrome still does the token
// exchange.

const FEDCM = {
  open: true, seq: 30, type: 'fedcm', fedcm: true, fedcmType: 'AccountChooser',
  title: 'Continue to pinterest.com with google.com', loginState: 'SignUp',
  accounts: [{ accountId: '1045', name: 'Srivatsan Balaji', email: 'srivatsan@reclaimprotocol.org' }],
  termsOfServiceUrl: 'https://www.pinterest.com/tos', privacyPolicyUrl: 'https://www.pinterest.com/privacy',
};

test('tapping the account replies with its index and the fedcm flag', () => {
  const { d, sent } = harness();
  d.apply(FEDCM);
  const acct = buttons(d._root()).find((b) => /Srivatsan Balaji/.test(allText(b).join('')));
  acct.onclick();
  assert.deepEqual(sent, [{ seq: 30, accept: true, accountIndex: 0, fedcm: true }]);
});

test('a second account replies with index 1, not a clamped 0', () => {
  // Usually one account, but a work + personal login is common, and selectAccount
  // takes an index — picking the wrong one would sign the user in as someone else.
  const { d, sent } = harness();
  d.apply({ ...FEDCM, accounts: [FEDCM.accounts[0], { accountId: '2', name: 'Work', email: 'w@corp.test' }] });
  buttons(d._root()).find((b) => /Work/.test(allText(b).join(''))).onclick();
  assert.deepEqual(sent, [{ seq: 30, accept: true, accountIndex: 1, fedcm: true }]);
});

test('Cancel replies accept=false — the only case allowed to dismiss', () => {
  // A dismissal puts FedCM on an exponential cooldown for the site (hours to
  // weeks), so it must come from the user and never from an error path.
  const { d, sent } = harness();
  d.apply(FEDCM);
  buttons(d._root()).find((b) => b.textContent === 'Cancel').onclick();
  assert.deepEqual(sent, [{ seq: 30, accept: false, accountIndex: -1, fedcm: true }]);
});

test('the sign-up disclosure and both consent links are shown', () => {
  const { d } = harness();
  d.apply(FEDCM);
  const text = allText(d._root()).join(' ');
  assert.match(text, /name, email address, and profile picture/);
  assert.match(text, /Terms of service/);
  assert.match(text, /Privacy policy/);
});

test('a returning sign-in drops the sharing CLAIM but keeps the links', () => {
  // Nothing new is shared on a return visit, so the notice would misstate it — but
  // the site's real terms and privacy policy should still be reachable.
  const { d } = harness();
  d.apply({ ...FEDCM, loginState: 'SignIn' });
  const text = allText(d._root()).join(' ');
  assert.equal(/name, email address, and profile picture/.test(text), false, 'no false claim');
  assert.match(text, /Terms of service/);
  assert.match(text, /Privacy policy/);
});

test('no avatar is fetched — the payload carries no image URL to render', () => {
  // pictureUrl is deliberately stripped server-side: rendering it would leak the
  // viewer's IP to Google and may be CSP-blocked.
  const { d } = harness();
  d.apply(FEDCM);
  const imgs = [];
  (function walk(el) { if (!el) return; if (el.tagName === 'IMG') imgs.push(el); (el.children || []).forEach(walk); })(d._root());
  assert.deepEqual(imgs, []);
});

test('the chooser closes on open:false', () => {
  const { d } = harness();
  d.apply(FEDCM);
  assert.equal(d.shown(), true);
  d.apply({ open: false });
  assert.equal(d.shown(), false);
});

// ---- hiding Chromium's own dialog --------------------------------------------
// Verified against the live protocol: there is NO way to suppress the native
// dialog. Page.javascriptDialogOpening only notifies, and FedCm.enable takes just
// disableRejectionDelay. So anything still blocking the page has Chromium's
// clipped dialog sitting in the stream behind our sheet. Our sheet is composited
// in the VIEWER, above the stream, so an opaque backdrop is what makes it the only
// visible UI. A notification alert has no native twin (already accepted), so it
// keeps the page visible.
function backdrop(d) { return (d._root().attributes || {}).style || ''; }

test('the FedCM chooser hides the stream, since the native chooser is behind it', () => {
  const { d } = harness();
  d.apply(FEDCM);
  assert.match(backdrop(d), /backdrop-filter:blur/);
});

test('a blocking confirm hides the stream too', () => {
  const { d } = harness();
  d.apply({ open: true, seq: 40, type: 'confirm', message: 'Sure?', url: 'https://e.gov.in/' });
  assert.match(backdrop(d), /backdrop-filter:blur/);
});

test('a narrow viewport gets a BOTTOM SHEET, not a full-height panel', () => {
  // The full-height version put a short message in the middle of a screen-sized dark
  // panel, inset by the wrapper padding — it read as a misplaced box. A bottom sheet
  // is content-height, edge to edge, resting on the bottom edge.
  const prev = globalThis.window.innerWidth;
  globalThis.window.innerWidth = 412; // Pixel 7
  const { d } = harness();
  d.apply(FEDCM);
  const box = d._root().children[0];
  const boxStyle = (box.attributes || {}).style || '';
  assert.match(boxStyle, /border-radius:20px 20px 0 0/, 'rounded top only');
  assert.equal(/height:100%/.test(boxStyle), false, 'height comes from content');
  assert.match((d._root().attributes || {}).style || '', /align-items:flex-end/, 'anchored to the bottom');
  assert.match((d._root().attributes || {}).style || '', /padding:0/, 'edge to edge — no inset margin');
  globalThis.window.innerWidth = prev;
});

test('a wide viewport keeps the centred card', () => {
  const prev = globalThis.window.innerWidth;
  globalThis.window.innerWidth = 1440;
  const { d } = harness();
  d.apply(FEDCM);
  const box = d._root().children[0];
  assert.match((box.attributes || {}).style || '', /max-width:360px/);
  globalThis.window.innerWidth = prev;
});

test('a notification alert stays translucent — nothing to hide', () => {
  const { d } = harness();
  d.apply({ open: true, seq: 41, type: 'alert', notify: true, message: 'x', url: 'https://e.gov.in/' });
  assert.match(backdrop(d), /rgba\(0,0,0,\.45\)/);
});
