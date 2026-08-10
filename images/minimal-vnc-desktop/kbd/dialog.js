// dialog.js — JS dialog sheet (alert / confirm / prompt / beforeunload).
//
// Chromium lays its native dialog out against the real browser WINDOW, not the
// emulated viewport, so under a narrow mobile emulation it overflows and the OK
// button can land off-screen. Because a dialog BLOCKS script execution, an
// unreachable button wedges the page — and the usual "fix", letting an automation
// layer auto-accept, is worse: the site's message disappears and a validation
// error shows the user nothing at all.
//
// So the proxy intercepts Page.javascriptDialogOpening (see emulate.go), streams
// it over the /kbd socket, and we draw it here as real DOM in the viewer: sharp,
// sized to the actual viewport, and dismissible. The reply goes back as
// accept/dismiss + text; the PROXY issues handleJavaScriptDialog, so the viewer
// never speaks CDP.
//
// Deliberately NOT done by overriding window.alert in the page: confirm() and
// prompt() must return synchronously, which an async sheet cannot do, and
// patching natives is a fingerprinting tell (alert.toString() stops reporting
// [native code]) — see the stealth notes in extensions/proxy/injected.js.
//
// createDialog({ sendReply }) — sendReply({seq, accept, text}) puts the answer on
// the /kbd socket. apply(state) is driven by the signal stream.

import { dbg } from './diag.js';

// Narrow viewports anchor the sheet to the BOTTOM edge to edge; wide ones centre a
// card. The first mobile attempt stretched the panel to full height with the message
// centred in it and kept the wrapper's 24px padding, which produced a huge empty dark
// box floating inside the stream — it read as a misplaced element, not a dialog.
function wrapLayout() {
  return (window.innerWidth || 0) < NARROW_PX
    ? 'align-items:flex-end;justify-content:stretch;padding:0;'
    : 'align-items:center;justify-content:center;padding:24px;';
}
const WRAP_BASE_CSS =
  'position:fixed;inset:0;z-index:2147483647;display:flex;box-sizing:border-box;' +
  '-webkit-tap-highlight-color:transparent;';
// Two backdrops, and the difference is load-bearing rather than cosmetic.
//
// Chromium draws its OWN dialog for anything still blocking the page — confirm,
// prompt, beforeunload, and the FedCM chooser — and there is no way to suppress it:
// Page.javascriptDialogOpening only notifies, and FedCm.enable takes nothing but
// disableRejectionDelay (verified against the live protocol). That native dialog is
// laid out against the real window, so at mobile width it is clipped and unusable,
// yet it still sits in the stream behind our sheet.
//
// Our sheet is in the VIEWER, composited above the stream — so an OPAQUE backdrop
// hides the stream, native dialog included. That is the whole trick: we cannot stop
// Chromium drawing it, but we can stop it being visible.
//
// A notification alert has no native twin (the proxy already accepted it), so
// nothing needs hiding and the translucent backdrop keeps the page in view.
const WRAP_CSS = WRAP_BASE_CSS + 'background:rgba(0,0,0,.45);';
// Glass, not opacity. A fully opaque backdrop hid Chromium's dialog but looked like
// a dead black screen; a plain translucent one would show the native dialog's text
// straight through and bring the duplicate back. A heavy BLUR gets both: the sheet
// reads as frosted glass, and the dialog behind is smeared past legibility.
//
// The blur is the load-bearing part, so the colour stays dark enough that if a
// browser ignores backdrop-filter the fallback is a dim scrim rather than a clearly
// readable dialog. -webkit- prefix for iOS Safari.
const GLASS_BLUR = 'backdrop-filter:blur(26px) saturate(140%);' +
  '-webkit-backdrop-filter:blur(26px) saturate(140%);';
const WRAP_OPAQUE_CSS = WRAP_BASE_CSS + 'background:rgba(6,7,9,.72);' + GLASS_BLUR;
// Dark glass with light text, matching the viewer's existing floating controls
// (rgba(20,20,20,.6) in ui.js). Dark is also the safe choice for contrast: the page
// behind can be any colour, and a light glass panel over a light page loses its
// edges and its text.
const BOX_BASE_CSS =
  'box-sizing:border-box;background:rgba(22,24,29,.88);color:#fff;' +
  'border:1px solid rgba(255,255,255,.2);' + GLASS_BLUR +
  'font:400 16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;';
const BOX_CARD_CSS = BOX_BASE_CSS +
  'width:100%;max-width:360px;border-radius:18px;padding:20px 20px 14px;' +
  'box-shadow:0 12px 40px rgba(0,0,0,.5);max-height:80%;overflow:auto;';
// Bottom sheet: full width, height driven by CONTENT (not the screen), rounded top
// corners, resting on the bottom edge. That is the native pattern on both platforms
// and it removes the acres of empty panel the full-height version had.
const BOX_SHEET_CSS = BOX_BASE_CSS +
  'width:100%;border:0;border-top:1px solid rgba(255,255,255,.16);' +
  'border-radius:20px 20px 0 0;padding:22px 20px calc(18px + env(safe-area-inset-bottom,0px));' +
  'max-height:80%;overflow:auto;box-shadow:0 -8px 32px rgba(0,0,0,.5);';
const NARROW_PX = 600; // phone-ish: bottom sheet below this, centred card above
function boxCss() {
  return (window.innerWidth || 0) < NARROW_PX ? BOX_SHEET_CSS : BOX_CARD_CSS;
}
const TITLE_CSS = 'margin:0 0 12px;font-size:17px;font-weight:600;line-height:1.35;' +
  'color:#fff;word-break:break-word;';
const ORIGIN_CSS = 'font-size:13px;color:rgba(255,255,255,.76);margin:0 0 8px;word-break:break-all;';
const MSG_CSS = 'margin:0 0 14px;white-space:pre-wrap;word-break:break-word;';
const INPUT_CSS =
  'width:100%;box-sizing:border-box;font:400 16px/1.3 inherit;padding:10px 12px;' +
  'background:rgba(255,255,255,.14);color:#fff;caret-color:#fff;' +
  'border:1px solid rgba(255,255,255,.2);border-radius:10px;margin:0 0 14px;';
const ROW_CSS = 'display:flex;gap:8px;justify-content:flex-end;';
const BTN_CSS =
  'appearance:none;border:0;border-radius:10px;padding:13px 22px;min-width:92px;' +
  'font:600 16px/1 inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;';
const BTN_OK_CSS = BTN_CSS + 'background:#1a73e8;color:#fff;';
const BTN_CANCEL_CSS = BTN_CSS + 'background:rgba(255,255,255,.18);color:#fff;';
// FedCM account row. Text only — no pictureUrl, so the viewer never fetches from
// lh3.googleusercontent.com (which would leak the viewer's IP to Google and may be
// CSP-blocked). Name plus email identifies the account unambiguously.
const ACCT_CSS =
  'display:block;width:100%;box-sizing:border-box;text-align:left;appearance:none;' +
  'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);' +
  'border-radius:12px;padding:15px 16px;margin:0 0 10px;font:inherit;color:#fff;' +
  'cursor:pointer;-webkit-tap-highlight-color:transparent;';
const ACCT_NAME_CSS = 'display:block;font-size:17px;font-weight:600;color:#fff;';
const ACCT_MAIL_CSS = 'display:block;font-size:14px;color:rgba(255,255,255,.82);word-break:break-all;';
const LINK_CSS = 'color:#a8c7ff;text-decoration:underline;font-weight:500;';
const DISCLOSE_CSS = 'margin:2px 0 16px;font-size:14px;line-height:1.6;color:rgba(255,255,255,.84);';

// Origin only — never the full URL with its query string, which routinely carries
// tokens and would end up rendered on screen (and in any recording of it).
function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ''; }
}

export function createDialog({ sendReply }) {
  let wrap = null;      // the overlay element (null when nothing is shown)
  let input = null;     // prompt text field
  let current = null;   // {seq, type}

  function teardown() {
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    wrap = null; input = null; current = null;
  }

  function answer(accept) {
    if (!current) return;
    const seq = current.seq;
    const notify = current.notify;
    const bridge = current.bridge;
    const text = accept && input ? input.value : '';
    // Take the sheet down immediately rather than waiting for the round trip:
    // on a slow link the page is blocked until the proxy answers, and leaving a
    // dead sheet up reads as a hang. javascriptDialogClosed confirms it.
    dbg('dialog reply accept=' + (accept ? 1 : 0) + ' type=' + (current.type || '-'));
    teardown();
    // Even a notification replies: the hub caches the dialog to resync viewers
    // that connect mid-dialog, and this is what clears that cache so the next
    // viewer isn't shown a message the user already dismissed.
    try { sendReply({ seq, accept, text, notify, bridge }); } catch (_) {}
  }

  // FedCM account chooser. Our sheet is a REMOTE CONTROL for Chrome's real dialog,
  // not a replacement: Chrome still performs the token exchange and its own origin
  // checks, and we relay only which account was tapped. Rendered as the VIEWER's UI
  // rather than a pixel copy of Chrome's chooser — FedCM exists partly to stop
  // pages faking sign-in prompts, so this should not imitate browser chrome.
  function showFedcm(d) {
    teardown();
    current = { seq: d.seq, type: 'fedcm', notify: false, bridge: false, fedcm: true };

    wrap = document.createElement('div');
    // Opaque: Chromium's own chooser is still on screen behind us and cannot be
    // suppressed, so hiding the stream is what leaves only this UI visible.
    wrap.setAttribute('style', WRAP_OPAQUE_CSS + wrapLayout());
    const box = document.createElement('div');
    box.setAttribute('style', boxCss());

    const h = document.createElement('p');
    h.setAttribute('style', TITLE_CSS);
    h.textContent = d.title || 'Choose an account';
    box.appendChild(h);

    // The disclosure is load-bearing for a first-time account: this is the consent
    // moment, and its terms/privacy links are part of what the user is agreeing to.
    // Shown verbatim in spirit rather than invented, and only when Chrome says this
    // is a sign-up rather than a returning sign-in.
    // The data-sharing CLAIM is only true on first use: for a returning account
    // (loginState 'SignIn') nothing new is shared, and Chrome's own dialog drops the
    // notice too. Saying it anyway would misstate what is happening.
    //
    // The LINKS are shown either way. Chrome sends them on every dialog, they are the
    // site's actual terms and privacy policy, and a user deciding whether to sign in
    // should be able to reach them whether or not it is their first time.
    const isSignUp = d.loginState === 'SignUp';
    if (isSignUp || d.termsOfServiceUrl || d.privacyPolicyUrl) {
      const disc = document.createElement('p');
      disc.setAttribute('style', DISCLOSE_CSS);
      if (isSignUp) {
        disc.appendChild(document.createTextNode(
          'To continue, your name, email address, and profile picture will be shared ' +
          'with this site. '));
      }
      if (d.termsOfServiceUrl) {
        const a = document.createElement('a');
        a.href = d.termsOfServiceUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.setAttribute('style', LINK_CSS);
        a.textContent = 'Terms of service';
        disc.appendChild(a);
      }
      if (d.termsOfServiceUrl && d.privacyPolicyUrl) disc.appendChild(document.createTextNode(' \u00b7 '));
      if (d.privacyPolicyUrl) {
        const a2 = document.createElement('a');
        a2.href = d.privacyPolicyUrl; a2.target = '_blank'; a2.rel = 'noopener noreferrer';
        a2.setAttribute('style', LINK_CSS);
        a2.textContent = 'Privacy policy';
        disc.appendChild(a2);
      }
      box.appendChild(disc);
    }

    // A LIST even though there is usually one account: `accounts` is an array and
    // selectAccount takes an index, so a single-account layout would break the
    // moment someone has a work and a personal login. With one entry it reads as a
    // single confirm row.
    const accounts = Array.isArray(d.accounts) ? d.accounts : [];
    accounts.forEach((acct, i) => {
      const b = document.createElement('button');
      b.setAttribute('style', ACCT_CSS);
      const n = document.createElement('span');
      n.setAttribute('style', ACCT_NAME_CSS);
      n.textContent = acct && acct.name ? acct.name : 'Account';
      const e2 = document.createElement('span');
      e2.setAttribute('style', ACCT_MAIL_CSS);
      e2.textContent = acct && acct.email ? acct.email : '';
      b.appendChild(n); b.appendChild(e2);
      b.onclick = () => answerFedcm(true, i);
      box.appendChild(b);
    });

    const row = document.createElement('div');
    row.setAttribute('style', ROW_CSS);
    const cancel = document.createElement('button');
    cancel.setAttribute('style', BTN_CANCEL_CSS);
    cancel.textContent = 'Cancel';
    // A user-initiated cancel is the ONLY case that may dismiss: Chrome puts FedCM
    // on an exponential cooldown for the site after a dismissal (hours to weeks),
    // so this must never be used as an error path.
    cancel.onclick = () => answerFedcm(false, -1);
    row.appendChild(cancel);
    box.appendChild(row);

    wrap.appendChild(box);
    document.body.appendChild(wrap);
    // Normal tier: this is the load-bearing question on a device — did the sheet
    // render at all, with how many accounts, and in which layout. Shape only.
    dbg('fedcm sheet n=' + accounts.length + ' state=' + (d.loginState || '-') +
        ' w=' + (window.innerWidth || 0) + ' sheet=' + ((window.innerWidth || 0) < NARROW_PX ? 1 : 0));
  }

  function answerFedcm(accept, accountIndex) {
    if (!current) return;
    const seq = current.seq;
    dbg('fedcm reply accept=' + (accept ? 1 : 0) + ' idx=' + accountIndex + ' seq=' + seq);
    teardown();
    try { sendReply({ seq, accept, accountIndex, fedcm: true }); } catch (_) {}
  }

  function show(d) {
    teardown();
    // notify: an alert the proxy already accepted natively (so Chromium's own
    // dialog is gone from the stream and the page is running again). There is
    // nothing to answer — tapping OK just closes our sheet.
    // bridge: raised by the extension's dialog bridge (a blocked sync XHR) rather
    // than by CDP. Echoed back in the reply because the two mechanisms keep
    // independent sequence counters — seq alone can't say which to resolve.
    current = { seq: d.seq, type: d.type || 'alert', notify: !!d.notify, bridge: !!d.bridge };
    const isPrompt = current.type === 'prompt';
    // beforeunload is the one dialog whose buttons aren't OK/Cancel — the choice
    // is leave-or-stay, and mislabelling it makes people lose form data.
    const isUnload = current.type === 'beforeunload';

    wrap = document.createElement('div');
    // A blocking dialog (confirm/prompt/beforeunload) still has Chromium's clipped
    // native dialog behind it — hide the stream. A notification alert doesn't, so
    // keep the page visible behind it.
    wrap.setAttribute('style', (current.notify ? WRAP_CSS : WRAP_OPAQUE_CSS) + wrapLayout());
    // NO stopPropagation here. The first version swallowed events in the CAPTURE
    // phase on this wrapper, which stopped them reaching our own OK button — the
    // sheet rendered but could not be dismissed. It also protected nothing: the
    // stream's gesture handlers are registered capture-on-document (tap.js), so
    // they run BEFORE anything on this element either way. Isolation is instead
    // done the way the magnify button already does it — tap.js asks
    // onDialogSheet(target) and ignores touches that land on us.

    const box = document.createElement('div');
    box.setAttribute('style', boxCss());

    const origin = originOf(d.url);
    if (origin) {
      const o = document.createElement('p');
      o.setAttribute('style', ORIGIN_CSS);
      // Same framing Chromium uses. Without it one origin's popup text could be
      // read as another's.
      o.textContent = origin + ' says';
      box.appendChild(o);
    }

    const msg = document.createElement('p');
    msg.setAttribute('style', MSG_CSS);
    msg.textContent = isUnload
      ? (d.message || 'Leave site? Changes you made may not be saved.')
      : (d.message || '');
    box.appendChild(msg);

    if (isPrompt) {
      input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('style', INPUT_CSS);
      input.value = d.defaultPrompt || '';
      box.appendChild(input);
    }

    const row = document.createElement('div');
    row.setAttribute('style', ROW_CSS);
    // alert() has no cancel path — a dismiss and an accept are the same thing, so
    // showing two buttons would imply a choice the page never offered.
    if (current.type !== 'alert') {
      const cancel = document.createElement('button');
      cancel.setAttribute('style', BTN_CANCEL_CSS);
      cancel.textContent = isUnload ? 'Stay' : 'Cancel';
      cancel.onclick = () => answer(false);
      row.appendChild(cancel);
    }
    const ok = document.createElement('button');
    ok.setAttribute('style', BTN_OK_CSS);
    ok.textContent = isUnload ? 'Leave' : 'OK';
    ok.onclick = () => answer(true);
    row.appendChild(ok);
    box.appendChild(row);

    wrap.appendChild(box);
    document.body.appendChild(wrap);

    // Focus the prompt field so the soft keyboard comes up in the same gesture
    // the sheet appeared in; a prompt with no keyboard is unanswerable on a phone.
    if (input) { try { input.focus(); input.select(); } catch (_) {} }
  }

  return {
    // Driven by the /kbd signal stream. State is absolute (open/closed), so a
    // dropped or duplicated frame is self-correcting like every other signal
    // here, and the hub resyncs a reconnecting viewer into an open dialog.
    apply(d) {
      if (!d || typeof d !== 'object') return;
      if (!d.open) { teardown(); return; }
      if (current && current.seq === d.seq && current.type === (d.type || 'alert')) return; // already showing
      if (d.type === 'fedcm') { showFedcm(d); return; }
      show(d);
    },
    shown() { return wrap !== null; },
    // Does this event target belong to the sheet? tap.js consults this so a tap on
    // the dialog is never also delivered to the remote page as a touch.
    owns(target) {
      if (!wrap || !target) return false;
      return wrap === target || (wrap.contains ? wrap.contains(target) : false);
    },
    // Test seam: the characterization suite asserts on the rendered sheet (button
    // labels per dialog type, and that no URL query text is displayed).
    _root() { return wrap; },
    // A detach/teardown must not leave a sheet stranded over a dead stream.
    reset() { teardown(); },
  };
}
