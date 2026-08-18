// env.js — platform detection, viewer-mode flags, and the shared clock.
//
// Pure environment reads derived once at load and never mutated. No imports;
// this is the leaf of the kbd/ module graph. Imported by kbd-autofocus.js (the
// stateful core) and by ./diag.js (nowMs only).

const ua = navigator.userAgent || '';
export const isAndroid = /android/i.test(ua);
export const isIOS =
  /iPad|iPhone|iPod/.test(ua) ||
  // iPadOS reports a desktop Mac UA; detect it by a Mac UA WITH touch points. A
  // real Mac / desktop Chrome reports maxTouchPoints 0, so this can't match them.
  // Subsumes the deprecated navigator.platform==='MacIntel' read (also touch-gated).
  (/Macintosh|Mac OS X/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
// Touch = a PRIMARY-touch device (phone/tablet). '(pointer: coarse)' is the
// reliable signal: true on phones/tablets, false on desktop AND touch-laptops
// (whose primary pointer is the mouse/trackpad). Do NOT use 'ontouchstart' in
// window — it's true in desktop Chrome, which falsely turned on the whole mobile
// layer (and the magnify button) on the desktop viewer.
const mm = window.matchMedia ? (q) => window.matchMedia(q).matches : () => false;
export const isTouch = mm('(pointer: coarse)') ||
  ((navigator.maxTouchPoints || 0) > 0 && !mm('(pointer: fine)'));
// Desktop (mouse) viewer. noVNC has NO IME support — it ignores keyCode 229 —
// so CJK/Japanese/Korean composition is dead on desktop. We run the same proxy
// IME capture as mobile, plus a full keysym forwarder for nav/shortcut keys,
// and toggle focus between our proxy (when a remote field is focused) and
// noVNC's canvas (otherwise, so page shortcuts/scroll still work).
export const DESKTOP = !isTouch;

// ?fixedw=NNN — the layout width to use for a page that OVERFLOWS the phone, in
// place of fitting to the measured scrollWidth. Applied only to such pages: one that
// fits stays native 1:1 and crisp (see kbd/fit.js handleTopDocSignal).
//
// The look it buys is the Kasm-style one: render at a narrow-ish fixed width so a
// site's normal (desktop) layout compacts rather than overflows, then one uniform
// downscale onto the phone. What makes it SAFE is that the width is a constant — the
// old rule fit to scrollWidth, so re-emulating wider made the page lay out as desktop,
// scrollWidth grew, and the re-layout confirmed its own misdiagnosis. A constant
// cannot escalate, which is why the detector can stay crude.
//
// The knob is a readability trade: scale = innerWidth / fixedw, so 560 on a 393px
// phone is 0.70 and 900 is 0.44. Range-clamped: below the phone's own width enterFit
// declines (there is nothing to scale down), and above FIT_MAX_W the framebuffer
// height can outgrow the kiosk window.
const fixedwMatch = /[?&]fixedw=(\d{2,4})/.exec(location.search);
export const FIXEDW = fixedwMatch ? Math.max(320, Math.min(1440, parseInt(fixedwMatch[1], 10))) : 0;

// FIXEDW implies MAGNIFY: the fit machinery it reuses (emulation POSTs, the
// framebuffer dance, the zoom controls) is all gated on MAGNIFY, so the flag would
// otherwise be silently inert.
export const MAGNIFY = /[?&]magnify=1/.test(location.search) || FIXEDW > 0;

// Scale-to-fill is the fullscreen magnify default. ?fill=0 keeps the 1:1
export const FILL = MAGNIFY && !/[?&]fill=0(?:&|$)/.test(location.search);

// (There is no ?extentfit flag: fitting the measured content extent was built, shipped
// behind a flag, and removed — along with the extension's ol/cw measurements that fed it.
// "Widest element in the document" and "the layout the user is looking at" are different
// quantities, and no threshold reconciles them: on a login modal over a feed it measured
// the feed. It would need a notion of the ACTIVE layout region to work.)

// Desktop-style stateless keyboard mode (?stateless=1). On a high-latency/lossy
// link the /kbd focus stream is seconds stale, and letting it DRIVE the keyboard
// (dismiss on editable=false, re-raise on a confirm) produces the raise/dismiss
// thrash that makes bad links feel broken. In this mode /kbd is ADVISORY only —
// it keeps rects fresh and drives the field lift, but never dismisses and never
// re-raises. Raise is optimistic & local (tap → keyboard now, no round-trip
// wait); dismiss comes only from real local events (button, system blur, the
// viewport actually growing back). Degrades like a desktop VNC client: laggy,
// never wedged. Local echo still masks per-keystroke latency.
export const STATELESS = /[?&]stateless=1/.test(location.search);

// Authoritative local mirror (?mirror=1). Opt-in — the fix for the iOS
// suggestion/autocorrect dead-end: instead of keeping the proxy
// input EMPTY and reverse-engineering keystrokes, SEED it with the remote
// field's real text (published as sync.val by the extension) and let the OS
// IME edit it natively. The IME finally has word context, so autocorrect,
// suggestion taps, glide and prediction all work — because it's a normal
// populated field. We then diff old→new value and send the delta as keysyms
// (the proven Android value-diff path), so the transport is unchanged.
//
// Scoped to the iOS <input> path for now — that is where it matters. Android
// already rides value-diff via EditContext; desktop and sensitive fields are
// untouched. Sensitive fields never publish val, so they can never be mirrored.
export const MIRROR = /[?&]mirror=1/.test(location.search);

// ?motionq=1 forces lower quality while scrolling.
export const MOTION_QUALITY_ALWAYS = /[?&]motionq=1/.test(location.search);

// The visible mirror bar is a SEPARATE, opt-in feature (?mirrorbar=1). It's NOT
// needed for the suggestion/autocorrect fix — that comes from seeding the hidden
// proxy so QuickType has context. The bar only adds instant WYSIWYG local echo
// (a compose-style bar above the keyboard) for slow links, replacing the echo
// pill. Off by default so ?mirror=1 is a zero-visual-change fix; typed text
// still shows in the real remote field.
export const MIRROR_BAR = MIRROR && /[?&]mirrorbar=1/.test(location.search);

// Native touch input channel — real touch points streamed to the remote (via
// the /input WS) instead of noVNC's touch->mouse. On only in magnify + touch.
// Derived once here so the touch-send path (touch-channel) and its gesture
// classifier (tap) can never disagree about whether it's active.
export const TOUCH_INPUT = MAGNIFY && isTouch;

// iOS raise bridge inside an iframe (?iosbridge=1). raiseKeyboard's iOS path
// normally uses a temp readonly <input> focused inside the gesture, handed to the
// real proxy on a double-RAF — that's what keeps the keyboard up while the async
// editable-confirm resolves. It has always been gated to top-level, with embedded
// iOS taking the simpler direct-focus branch; that split dates from the original
// port, not from a discovered iframe incompatibility. Nothing in the
// bridge needs a top-level document (the temp input lives in OUR document and the
// gesture is OURS), so this flag ungates it for A/B on a real device. Default off:
// the direct-focus path is what has shipped embedded, and only device evidence
// should change that.
export const IOS_BRIDGE_IN_IFRAME = /[?&]iosbridge=1/.test(location.search);

// Same-origin sibling endpoint path: swap the last path segment of our own URL
// for `suffix` (e.g. '/vnc/liveview.html' + '/kbd' -> '/vnc/kbd'). The proxy
// serves /kbd, /input, /emulate, /klog next to the viewer page. Guards a leading
// slash so the result is always an absolute same-origin path.
export function siblingPath(suffix) {
  const p = location.pathname.replace(/\/[^/]*$/, suffix);
  return p.startsWith('/') ? p : '/' + p;
}

// Monotonic-ish millisecond clock. performance.now() when available (immune to
// wall-clock jumps), Date.now() otherwise.
export function nowMs() {
  return (window.performance && performance.now) ? performance.now() : Date.now();
}
