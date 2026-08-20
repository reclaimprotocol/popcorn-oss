// mirror-bar.js — the visible mirror bar (A1, opt-in via ?mirrorbar=1).
//
// In mirror mode the proxy holds the field's real text, so instead of hiding it
// and drawing a separate "unconfirmed" echo pill, we PROMOTE the proxy into a
// styled input bar pinned just above the keyboard. The seeded text and the
// native caret then render INSTANTLY as you type — the proxy IS the local echo,
// so there's zero drift by construction (you see exactly what will be sent) and
// the pill is redundant. Reverts to the invisible focus-target on dismiss.
//
// createMirrorBar(deps): mirrorOn is the core's hoisted mode predicate;
// getVisibleBottom comes from the viewport-transform instance; hideEchoPill is
// the echo module's (the bar supersedes the pill). shown() feeds the echo
// factory's getMirrorBarShown accessor and applySignal's promote guard.

import { MIRROR_BAR } from './env.js';
import { dbg } from './diag.js';

export function createMirrorBar({ getProxy, mirrorOn, getVisibleBottom, hideEchoPill }) {
  let mirrorBarShown = false;

  function show() {
    const proxy = getProxy();
    if (!MIRROR_BAR || !mirrorOn() || !proxy) return; // opt-in; invisible otherwise
    if (mirrorBarShown) { position(); return; } // already up — just re-pin
    dbg('mirror bar show len=' + (proxy.value != null ? proxy.value.length : (proxy.textContent || '').length));
    mirrorBarShown = true;
    const s = proxy.style;
    s.opacity = '1';
    s.width = 'auto'; s.height = '';
    s.left = '8px'; s.right = '8px'; s.top = 'auto';
    s.position = 'fixed';
    s.boxSizing = 'border-box';
    s.padding = '10px 14px';
    s.borderRadius = '12px';
    s.background = 'rgba(28,28,30,.96)';
    s.color = '#fff';
    s.caretColor = '#4c8dff';
    s.font = '400 17px/1.35 -apple-system,system-ui,"Segoe UI",sans-serif';
    s.border = '0';
    s.boxShadow = '0 4px 16px rgba(0,0,0,.35)';
    s.transition = 'bottom .18s ease';
    position();
    // Keyboard geometry is still settling at show time; re-pin as it lands so the
    // bar sits just above the keyboard rather than briefly behind it.
    requestAnimationFrame(position);
    setTimeout(position, 150);
    setTimeout(position, 400);
    hideEchoPill(); // the bar supersedes the pill
  }

  function position() {
    const proxy = getProxy();
    if (!mirrorBarShown || !proxy) return;
    const kbTop = getVisibleBottom();
    proxy.style.bottom = Math.max(8, window.innerHeight - kbTop + 8) + 'px';
    proxy.style.top = 'auto';
  }

  function hide() {
    const proxy = getProxy();
    if (!mirrorBarShown || !proxy) return;
    mirrorBarShown = false;
    const s = proxy.style;
    // Restore the invisible focus-target look (see PROXY_STYLE in setup). left/top
    // are owned by moveProxyTo/parkProxyOffscreen, so leave them alone.
    s.opacity = '0.01';
    s.width = '40px'; s.height = '20px';
    s.right = 'auto'; s.bottom = 'auto';
    s.padding = '0'; s.margin = '0';
    s.borderRadius = '0'; s.border = '0'; s.borderBottom = '0';
    s.background = 'transparent'; s.color = 'transparent'; s.caretColor = 'transparent';
    s.boxShadow = 'none'; s.transition = ''; s.font = ''; s.fontSize = '16px';
  }

  return { show, position, hide, shown: () => mirrorBarShown };
}
