// host-bridge.js — the parent<->child postMessage contract for an EMBEDDED
// viewer (the portal iframes liveview.html).
//
// Why this module exists: everything the layer does is correct in a top-level
// tab, but one input is structurally unavailable inside a cross-origin iframe —
// the soft keyboard's GEOMETRY. `navigator.virtualKeyboard` exists but stays
// mute unless the embed carries allow="virtual-keyboard", and a subframe's
// visualViewport does not reliably shrink when the keyboard opens. Without a
// keyboard rect there is no lift: the focused remote field sits behind the keys
// (currentVisibleBottom falls back to innerHeight) and the paste button lands on
// top of them (controls.js computes a zero inset).
//
// The fix is not to guess harder in here — it's to ask the one document that
// CAN measure. The embedder is top-level, so VirtualKeyboard + visualViewport
// are always authoritative there; it measures and posts the rect in. Geometry
// measurement does not have to happen in the document that renders the stream.
//
// This module owns ONLY the wire: origin policy, the inbound dispatch table,
// and the last host geometry (+ its staleness). It deliberately holds no
// keyboard state — kbd-detect.js consumes hostGeometry() as its highest-priority
// detector, and viewport-transform.js reads it in currentVisibleBottom().
//
// Fail-closed inbound, backward-compatible outbound:
//   * INBOUND messages (geometry, toggles, paste) are accepted only when
//     ?parentOrigin= is configured AND the message came from window.parent with
//     that exact origin. Unauthenticated geometry would let any embedder wedge
//     the lift, and unauthenticated paste would let it type into the remote
//     field, so an unconfigured viewer simply ignores all inbound messages and
//     behaves exactly as it does today.
//   * OUTBOUND keeps targetOrigin '*' when unconfigured (that is the existing
//     POPCORN_VIEWPORT behavior, relied on by current embedders) and tightens to
//     the configured origin when present, so viewport geometry stops being
//     readable by any page that frames us.

import { dbg } from './diag.js';
import { nowMs } from './env.js';
import { linkLatency } from './latency.js';

// Wire-format version. Bump on any BREAKING change to the message shapes; the
// embedder receives it in POPCORN_HELLO and should refuse to drive a viewer it
// doesn't understand rather than silently mis-driving it (a skewed portal + pod
// pair is the failure mode this exists to make loud).
export const HOST_PROTOCOL = 1;

// Configured embedder origin, e.g. ?parentOrigin=https%3A%2F%2Fportal.example.
// Null when absent (standalone phone tab, or an embedder that hasn't opted in).
const PARENT_ORIGIN = (function () {
  try {
    const raw = new URLSearchParams(location.search).get('parentOrigin');
    if (!raw) return null;
    // Normalize to a bare origin: an embedder that passes a full URL (or a
    // trailing slash) must not silently fail the === comparison below.
    return new URL(raw).origin;
  } catch (_) { return null; }
})();

const EMBEDDED = (function () { try { return window !== window.top; } catch (_) { return true; } })();

// How long a host geometry sample stays authoritative. If the embedder's JS
// dies, is throttled while backgrounded, or simply stops posting, the viewer
// must not keep applying a frozen lift forever — after this window the local
// detectors (VK / visualViewport / layout-resize) take back over. Generous
// enough that a normal idle period (no keyboard changes = no messages) does not
// flap: the embedder re-posts on every geometry change AND on a heartbeat.
const HOST_GEOM_STALE_MS = 8000;
// ...but 8s is a statement about a FAST link, and it is applied on the slowest
// ones. The window has to cover the embedder's 3s heartbeat plus whatever the
// network does to it; on a phone that has dropped to 3G mid-session, two
// heartbeats can easily arrive late enough to age out a host that is alive and
// measuring correctly — and the viewer then flips to local detectors mid-typing,
// which in a cross-origin iframe means flipping to detectors that see nothing.
//
// So scale it with the latency we already measure (the same signal quality.js and
// the dismiss windows use), keeping 8s as the FLOOR so nothing gets shorter than
// today, and capping it so a genuinely dead embedder is still noticed promptly.
const HOST_GEOM_STALE_MAX_MS = 20000;
function staleWindowMs() {
  return Math.min(HOST_GEOM_STALE_MAX_MS, Math.max(HOST_GEOM_STALE_MS, 6 * linkLatency()));
}
// Absolute malformed-input guard; host geometry can exceed this iframe's height.
const MAX_HOST_OCCLUSION_PX = 4096;

let geom = null;      // { visibleHeight, occludedBottom, at }
// The boot HELLO can race a framework mounting its parent-side bridge.  Keep the
// last capability payload so an authenticated parent can explicitly ask us to
// repeat it once its listener is ready.
let helloPayload = null;
// Has the embedder ever demonstrated it can actually SEE the keyboard?
//
// This gate exists because of a specific, reproducible portal failure. Host
// geometry SUPPRESSES our local detectors (kbd-detect.js) — deliberately, since two
// detectors driving the lift with different heights is what causes keyboard-open
// jitter. But an embedder that posts geometry it cannot measure suppresses them
// with a lie: a middle frame whose own PopcornHost fell back to measuring itself is
// a cross-origin iframe whose visualViewport never shrinks, so it heartbeats
// occludedBottom:0 forever. The viewer then has a FRESH host sample saying "no
// keyboard", its own detectors are muted, and the result is no lift, no pan budget,
// the focused field behind the keys — and the local-echo pill positioned at the
// bottom of the screen, i.e. behind the keyboard too, so the one mechanism that
// masks per-keystroke round-trip latency is invisible. Typing then looks completely
// dead until the remote's pixels come back.
//
// So a host earns authority by reporting a real occlusion at least once. Until
// then its samples are still readable (hostGeometry() returns them — 0 is a
// legitimate value) but they do not take the local detectors off the field.
// Sticky afterwards: a measurer that has proved itself and then legitimately
// reports 0 IS reporting a dismissal, which must keep working.
let hostEverOccluded = false;
let handlers = null;  // installed dispatch table
let lifecycleAckHandler = null;

export function onLifecycleAck(handler) {
  lifecycleAckHandler = typeof handler === 'function' ? handler : null;
}

/**
 * Last host-reported viewport geometry, or null when none has arrived (or the
 * newest sample has gone stale). visibleHeight is the usable height in CSS px;
 * occludedBottom is the keyboard's height (0 when dismissed).
 */
export function hostGeometry() {
  if (!geom) return null;
  if (nowMs() - geom.at > staleWindowMs()) return null;
  return geom;
}

/**
 * Age of the newest host sample in ms, or -1 when none has ever arrived. Reads
 * the raw sample rather than hostGeometry(), so it still answers AFTER the
 * staleness window has expired — which is exactly when somebody wants to know.
 */
export function hostGeometryAge() {
  return geom ? Math.max(0, nowMs() - geom.at) : -1;
}

/** How long a sample stays authoritative right now (link-scaled; see above). */
export function hostGeometryStaleMs() { return staleWindowMs(); }

/**
 * True when the embedder is actively feeding geometry, i.e. the local keyboard
 * detectors must stand down. Used as an exclusivity latch: two detectors driving
 * the lift with slightly different heights is what causes keyboard-open jitter,
 * so host geometry must SUPPRESS rather than race them.
 */
export function hostGeometryActive() {
  return hostEverOccluded && hostGeometry() !== null;
}

/**
 * Post a message to the embedder.
 *
 * Deliberately NOT gated on being embedded: top-level, window.parent IS window,
 * so this posts harmlessly to ourselves (nothing in the layer listens for these
 * types). That is the pre-existing POPCORN_VIEWPORT behavior and the
 * characterization tests assert on it, so keep it — an EMBEDDED guard here would
 * silently drop the outbound stream in any top-level context.
 */
export function postToHost(type, data) {
  try {
    const msg = data ? Object.assign({ type: type }, data) : { type: type };
    window.parent.postMessage(msg, PARENT_ORIGIN || '*');
  } catch (_) {}
}

/**
 * Report a real user interaction with the REMOTE page, so an embedding host can
 * keep its own product analytics working.
 *
 * A host that used to drive input itself (e.g. over CDP) had a natural choke
 * point where every user action passed through, and derived its funnel from it —
 * first interaction, started typing, form submitted, session abandonment. Once
 * input moves in here, that choke point is ours, so we have to emit the same
 * signal or the host goes blind.
 *
 * The vocabulary deliberately mirrors CDP's Input.* domain, because that is what
 * hosts already map: 'char' (one text-entry event, like Input.insertText),
 * 'special' (a named key, like a dispatchKeyEvent keyDown), 'click' (a tap /
 * mousePressed) and 'scroll'.
 *
 * NEVER pass typed text. `detail` is for a named key only ('Enter', 'Backspace'),
 * and callers route it through safeKeyName() so a printable character can't leak
 * into a host's analytics pipeline.
 */
export function reportInteraction(kind, detail) {
  postToHost('POPCORN_INTERACTION', detail ? { kind, detail } : { kind });
}

/**
 * Announce ourselves to the embedder. Sent once the viewer is live so the host
 * knows the protocol version it's talking to and can start posting geometry.
 */
export function sayHello(extra) {
  if (extra) helloPayload = Object.assign({}, extra);
  postToHost('POPCORN_HELLO', Object.assign({ protocol: HOST_PROTOCOL }, helloPayload || {}));
}

/**
 * Install the inbound listener. `table` maps command names to functions:
 *   onGeometry({ visibleHeight, occludedBottom })  host measured the keyboard
 *   onToggleMagnify()                              host's magnify button
 *   onToggleKeyboard()                             host's keyboard button
 *   onPaste(text)                                  host read its clipboard
 *   onHostLayout(report)                           host audited its own embedding
 *
 * Every entry is optional; unknown message types are ignored. Safe to call in a
 * top-level tab — with no configured parent origin nothing is ever dispatched.
 */
export function installHostBridge(table) {
  handlers = table || {};
  if (!EMBEDDED) return;
  if (!PARENT_ORIGIN) {
    // Embedded but not opted in: outbound still works (POPCORN_VIEWPORT, as
    // today), inbound is dead. Logged because "the portal's buttons do nothing"
    // is otherwise a silent mystery, and a missing permissions/origin string is
    // exactly the class of bug that shipped once already (see Batch 17).
    dbg('host-bridge: embedded without ?parentOrigin= -> inbound disabled');
    return;
  }
  dbg('host-bridge: inbound armed proto=' + HOST_PROTOCOL);
  window.addEventListener('message', onMessage);
  // No sayHello() here: viewer.js already sent one at boot, with the capability
  // fields a host needs (vk/vv), and it sends it whether or not inbound is armed so
  // a host can detect a viewer that was loaded without ?parentOrigin=. A second
  // bare hello would just make the host re-prime geometry and double-log.
}

function onMessage(e) {
  // Fail closed: exact origin match AND the real parent window. event.source
  // pins it to the frame that embeds us, so a same-origin popup or a nested
  // frame can't drive the remote session.
  if (e.origin !== PARENT_ORIGIN) return;
  try { if (e.source !== window.parent) return; } catch (_) { return; }
  const d = e.data;
  if (!d || typeof d.type !== 'string') return;

  switch (d.type) {
    // Mount-order recovery: the host may attach after viewer.js's one-shot boot
    // hello.  This request is accepted only through the same exact-origin,
    // exact-parent gate above, and it carries no data, so it cannot broaden the
    // bridge's authority or leak session state.
    case 'POPCORN_HELLO_REQUEST':
      sayHello();
      return;
    case 'POPCORN_HOST_GEOMETRY': {
      const vh = Number(d.visibleHeight);
      const ob = Number(d.occludedBottom);
      // Reject malformed values; occlusion also controls the pan budget.
      if (!isFinite(vh) || vh <= 0 || !isFinite(ob) || ob < 0) return;
      if (ob > MAX_HOST_OCCLUSION_PX) return;
      // No handler = this viewer has no keyboard to lift (desktop wires onPaste
      // only). Storing geom anyway would still make hostGeometryActive() true and
      // feed currentVisibleBottom a keyboard rect that means nothing here.
      if (!handlers.onGeometry) return;
      if (ob > 0 && !hostEverOccluded) {
        hostEverOccluded = true;
        dbg('host-bridge: embedder proved it can see the keyboard -> local detectors stand down');
      }
      geom = { visibleHeight: vh, occludedBottom: ob, at: nowMs() };
      handlers.onGeometry(geom);
      return;
    }
    case 'POPCORN_TOGGLE_MAGNIFY':
      if (handlers.onToggleMagnify) handlers.onToggleMagnify();
      return;
    case 'POPCORN_TOGGLE_KBD':
      if (handlers.onToggleKeyboard) handlers.onToggleKeyboard();
      return;
    case 'POPCORN_PASTE':
      if (typeof d.text === 'string' && d.text && handlers.onPaste) handlers.onPaste(d.text);
      return;
    // The embedder's own layout audit (popcorn-host.js auditLayout). We cannot see
    // our ancestors from in here — a cross-origin frame has no view of the page
    // above it — and the compositor's raster scale is not observable from either
    // side, so this is the ONLY signal that can attribute "the stream looks blurry"
    // to the embedding rather than to the encoder. Structural codes only; recorded,
    // never acted on (a viewer that started restyling its host would be worse than
    // the blur).
    case 'POPCORN_HOST_LAYOUT': {
      if (!handlers.onHostLayout) return;
      var issues = Array.isArray(d.issues) ? d.issues : null;
      if (!issues) return;
      // Codes are a closed vocabulary from our own script; drop anything that
      // isn't one rather than logging a string an embedder chose.
      const safe = issues.filter((c) => typeof c === 'string' && /^[a-z-]{1,24}$/.test(c)).slice(0, 12);
      handlers.onHostLayout({
        issues: safe,
        depth: Number.isFinite(d.depth) ? d.depth : null,
        dpr: Number.isFinite(d.dpr) ? d.dpr : null,
        cssW: Number.isFinite(d.cssW) ? Math.round(d.cssW) : null,
        cssH: Number.isFinite(d.cssH) ? Math.round(d.cssH) : null,
        top: d.top === true,
        reason: typeof d.reason === 'string' && /^[a-z-]{1,16}$/.test(d.reason) ? d.reason : '-',
      });
      return;
    }
    case 'POPCORN_HOST_ACK':
      if (Number.isInteger(d.seq) && d.seq > 0 && lifecycleAckHandler) lifecycleAckHandler(d.seq);
      return;
    default:
      return;
  }
}
