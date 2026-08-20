// fbtarget.js — keep the framebuffer and CDP CSS viewport in agreement.

// == proxy/emulate.go setDeviceMetricsOverride clamp. Bounds the PRODUCT: a factor
// is dropped rather than allowed to ask for a framebuffer the proxy will reject.
export const FB_MAX = 4096;

let scale = 1;

/** Set the supersampling factor. Integer only — see the rounding note below. */
export function setFbScale(k) {
  scale = Math.max(1, Math.round(k || 1));
  return scale;
}

export function fbScale() { return scale; }

export function fbTarget(w, h, env) {
  const g = env || (typeof window !== 'undefined' ? window : {});
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const cap = g.__pcnFbCap;
  let cw = w, ch = h;
  if (cap && cap.w > 0 && cap.h > 0) {
    if (!g.__pcnFill) { cw = Math.min(w, cap.w); ch = Math.min(h, cap.h); }
    else {
      const s = Math.min(1, cap.w / w, cap.h / h); // shrink to fit the cap, preserving aspect
      cw = Math.max(1, Math.round(w * s)); ch = Math.max(1, Math.round(h * s));
    }
  }
  // INTEGER factors only. A fractional one (1.5) puts cssW * k on a half pixel;
  // whichever side rounds first wins and the two disagree by a pixel, which is the
  // clipped-right-edge failure this module exists to make impossible.
  let k = Math.max(1, Math.round(g.__pcnFbScale != null ? g.__pcnFbScale : scale));
  while (k > 1 && (cw * k > FB_MAX || ch * k > FB_MAX)) k--;
  return { w: cw * k, h: ch * k, cssW: cw, cssH: ch, scale: k };
}
