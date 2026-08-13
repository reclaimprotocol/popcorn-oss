// proxy-setup.js — builds the hidden proxy element for each platform path and
// wires its event listeners.
//
//   desktop: hidden 1px <input> capturing IME + text; dedicated keydown
//            forwarder for nav/shortcut keys. No touch/soft-keyboard machinery.
//   ec:      Chromium/Android EditContext on a plain div — glide/swipe typing
//            and the prediction bar work through it natively.
//   input:   iOS / older browsers — hidden <input> with the value-diff logic.
//
// Also builds the iOS accessory-bar sentinels (Safari's prev/next arrows focus
// a sentinel; we translate that to Tab/Shift+Tab on the REMOTE form).
//
// Pure DOM construction: buildProxy(mode, handlers, navRemoteField) returns
// { proxy, editCtx } — the core stores the proxy and hands both to the input
// state machine (input.setProxy / input.setEditContext).

import { isIOS } from './env.js';
import { PROXY_STYLE } from './ui.js';

export function buildProxy(mode, h, navRemoteField) {
  if (mode === 'desktop') {
    const proxy = document.createElement('input');
    proxy.type = 'text';
    proxy.className = 'mobile-proxy-input';
    proxy.setAttribute('autocomplete', 'off');
    proxy.setAttribute('autocorrect', 'off');
    proxy.setAttribute('autocapitalize', 'off');
    proxy.setAttribute('spellcheck', 'false');
    proxy.setAttribute('tabindex', '0');
    // Fixed 1px, invisible, top-left — focusing it never scrolls the page.
    proxy.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;' +
      'opacity:0;border:0;outline:0;padding:0;margin:0;background:transparent;' +
      'color:transparent;caret-color:transparent;z-index:-1;';
    proxy.addEventListener('keydown', h.onDesktopKeyDown);
    proxy.addEventListener('input', h.onDesktopInput);
    proxy.addEventListener('compositionstart', h.onCompositionStart);
    proxy.addEventListener('compositionupdate', h.onCompositionUpdate);
    proxy.addEventListener('compositionend', h.onCompositionEnd);
    proxy.addEventListener('paste', h.onProxyPaste);
    document.body.appendChild(proxy);
    return { proxy, editCtx: null };
  }

  let proxy, editCtx = null;
  if (mode === 'ec') {
    // Chromium/Android: standards-based EditContext on a plain div.
    proxy = document.createElement('div');
    proxy.className = 'mobile-proxy-input';
    proxy.setAttribute('tabindex', '0');
    proxy.setAttribute('role', 'textbox');
    proxy.setAttribute('inputmode', 'text');
    // Autocorrect off by default (see applyProxyImeHints): no auto-accept of a
    // correction on space — corrections apply only when the user taps a
    // suggestion. Set at creation too so the IME sees it before the first focus.
    proxy.setAttribute('spellcheck', 'false');
    proxy.setAttribute('autocorrect', 'off');
    proxy.style.cssText = PROXY_STYLE;
    editCtx = new window.EditContext();
    proxy.editContext = editCtx;
    editCtx.addEventListener('textupdate', h.onECTextUpdate);
    editCtx.addEventListener('compositionstart', h.onCompositionStart);
    editCtx.addEventListener('compositionend', h.onECCompositionEnd);
    proxy.addEventListener('keydown', h.onECKeyDown);
    proxy.addEventListener('blur', h.onProxyBlur);
  } else {
    // iOS / older browsers: hidden <input> with the value-diff IME logic.
    proxy = document.createElement('input');
    proxy.type = 'text';
    proxy.className = 'mobile-proxy-input';
    proxy.setAttribute('autocomplete', 'off');
    proxy.setAttribute('autocorrect', 'off');
    proxy.setAttribute('autocapitalize', 'off');
    proxy.setAttribute('spellcheck', 'false');
    proxy.setAttribute('inputmode', 'text');
    proxy.setAttribute('tabindex', '0');
    proxy.style.cssText = PROXY_STYLE;
    proxy.addEventListener('beforeinput', h.onProxyBeforeInput);
    proxy.addEventListener('input', h.onProxyInput);
    proxy.addEventListener('keydown', h.onProxyKeyDown);
    proxy.addEventListener('blur', h.onProxyBlur);
    proxy.addEventListener('compositionstart', h.onCompositionStart);
    proxy.addEventListener('compositionupdate', h.onCompositionUpdate);
    proxy.addEventListener('compositionend', h.onCompositionEnd);
  }
  // NOTE: the explicit clipboard API is intentionally NOT wired on mobile
  // (Android/iOS). No 'paste' interception here and no remote->local mirror in
  // attach() — pasting a field still works via the normal input path (the
  // pasted text arrives as an 'input'/value change and is forwarded like
  // typing). Desktop keeps the full copy/paste handlers.
  document.body.appendChild(proxy);

  // iOS accessory-bar prev/next (^ v) -> remote Shift+Tab / Tab. Bracket the
  // proxy with off-screen focusable sentinels so Safari's arrows have somewhere
  // to move; focusing a sentinel is our cue to navigate the remote form. iOS
  // only (Safari's <input> path); Android/EditContext has no such accessory.
  if (isIOS && proxy.tagName === 'INPUT') {
    const makeSentinel = (leftPx) => {
      const s = document.createElement('input');
      s.type = 'text';
      s.setAttribute('autocomplete', 'off');
      s.setAttribute('autocorrect', 'off');
      s.setAttribute('autocapitalize', 'off');
      s.setAttribute('spellcheck', 'false');
      s.tabIndex = 0;
      // Must be IN the viewport and NOT aria-hidden, or iOS Safari drops it from
      // the accessory-bar prev/next chain (which is why off-screen sentinels did
      // nothing). Keep it a 1px, transparent, non-interactive-looking sliver in
      // the top-left corner where a stray tap is unlikely.
      s.style.cssText = 'position:fixed;top:0;left:' + leftPx + 'px;width:1px;height:1px;' +
        'font-size:16px;opacity:0.01;border:0;padding:0;margin:0;background:transparent;' +
        'color:transparent;caret-color:transparent;';
      return s;
    };
    const prevS = makeSentinel(), nextS = makeSentinel();
    prevS.addEventListener('focus', () => navRemoteField(-1));
    nextS.addEventListener('focus', () => navRemoteField(1));
    // Tab order (DOM order): prevSentinel -> proxy -> nextSentinel.
    proxy.parentNode.insertBefore(prevS, proxy);
    if (proxy.nextSibling) proxy.parentNode.insertBefore(nextS, proxy.nextSibling);
    else proxy.parentNode.appendChild(nextS);
  }

  return { proxy, editCtx };
}
