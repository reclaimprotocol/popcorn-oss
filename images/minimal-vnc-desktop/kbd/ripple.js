// ripple.js — instant local tap feedback. No state, no imports.
//
// On a 1-3s RTT link, a tap gives ZERO feedback until the remote's hover/active
// pixels round-trip, so users tap again (double-activations). Draw an instant
// viewer-side ripple at the touch point — purely local, in the same frame as
// the touch — so the UI feels alive regardless of network.
export function showTapRipple(x, y) {
  let d;
  try {
    d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:' + (x - 22) + 'px;top:' + (y - 22) + 'px;' +
      'width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.28);' +
      'pointer-events:none;z-index:2147483646;transform:scale(.35);opacity:.85;' +
      'transition:transform .32s cubic-bezier(.22,.61,.36,1),opacity .32s ease-out;';
    document.body.appendChild(d);
    requestAnimationFrame(() => {
      if (!d) return;
      d.style.transform = 'scale(1)';
      d.style.opacity = '0';
    });
    setTimeout(() => { if (d && d.parentNode) d.parentNode.removeChild(d); }, 360);
  } catch (_) { if (d && d.parentNode) d.parentNode.removeChild(d); }
}
