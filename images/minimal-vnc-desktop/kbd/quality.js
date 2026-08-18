// quality.js — adaptive framebuffer quality on a slow link. Two independent
// consumers lower JPEG quality to buy back bytes-per-frame on a thin downlink:
//
//   typing  (lower / restore)  — glyph/caret echo lands 2-4x sooner while the
//                                keyboard is up (tiny text regions, quality drop
//                                nearly invisible).
//   motion  (noteMotion)       — a forwarded touch-scroll/drag re-encodes big
//                                regions every frame; halving JPEG bytes lets
//                                2-4x more frames through (slideshow -> smooth),
//                                full quality returning ~300ms after motion stops.
//                                On a thin uplink it's frame SIZE, not RTT, that
//                                gates scroll fluidity — this is the lever.
//
// Both ride noVNC's live rfb.qualityLevel setter (re-sent as SetEncodings), so no
// protocol additions and device-agnostic — identical on every phone/OEM/iOS. They
// SHARE one savedQuality stash keyed by a reason set: quality is restored only
// once BOTH reasons clear, so a scroll that settles mid-typing can't yank quality
// back up under the keyboard, and a keyboard dismiss mid-scroll can't either.
// Typing remains latency-gated; motion can be forced for diagnostics.
//
// createQuality({ getRfb }) closes over a live accessor for the (reconnect-
// swappable) RFB instance and the shared linkLatency() estimate.

import { linkRtt } from './latency.js';
import { MOTION_QUALITY_ALWAYS } from './env.js';
import { dbg } from './diag.js';

const LOW_QUALITY = 6;          // Preserve legibility while masking a slow link
const SLOW_RTT_MS = 500;        // only degrade once the link is actually slow
const MOTION_RESTORE_MS = 300;  // settle delay after the last forwarded scroll frame

// Keep first paint at full fidelity. A framebuffer is a bitmap, so any JPEG loss
// at connect is magnified with the rest of the page and makes browser text soft.
export const COLD_QUALITY = 9;
export const REFINE_IDLE_MS = 600;  // settle window before stepping up to sharp

export function createQuality({ getRfb }) {
  let savedQuality = null;      // configured quality, stashed while lowered
  const reasons = new Set();    // active lowerers: 'typing' and/or 'motion'
  let motionTimer = null;

  // Refinement state. `sharp` is the quality the viewer configured (captured at
  // connect); `refined` says whether we've stepped up to it yet.
  let sharp = null;
  let refined = true;
  let refineTimer = null;

  /** Where quality belongs when nothing is actively lowering it. */
  function targetQuality() {
    if (sharp === null) return null;
    return refined ? sharp : COLD_QUALITY;
  }

  function write(q) {
    const rfb = getRfb();
    if (!rfb || q === null) return;
    try { rfb.qualityLevel = q; } catch (_) {}
  }

  function lowerFor(reason) {
    const rfb = getRfb();
    if (!rfb) return;
    if (!(reason === 'motion' && MOTION_QUALITY_ALWAYS) && linkRtt() < SLOW_RTT_MS) return;
    reasons.add(reason);
    if (savedQuality !== null) return;         // already lowered by another reason
    try {
      const cur = rfb.qualityLevel;
      if (typeof cur !== 'number' || cur <= LOW_QUALITY) return; // nothing to gain
      savedQuality = cur;
      rfb.qualityLevel = LOW_QUALITY;
    } catch (_) { savedQuality = null; }
  }

  function restoreFor(reason) {
    reasons.delete(reason);
    if (reasons.size > 0) return;              // another reason still holds it low
    if (savedQuality === null) return;
    const q = savedQuality;
    savedQuality = null;
    const rfb = getRfb();
    if (!rfb) return; // detach: the next rfb reconnects at its configured quality
    // Restore to the CURRENT target, not the stashed value: a refinement that
    // completed while quality was held low (a long scroll on a slow link) must not
    // be undone by restoring the pre-refine number.
    const t = targetQuality();
    try { rfb.qualityLevel = t === null ? q : Math.max(q, t); } catch (_) {}
  }

  return {
    /**
     * Called on every RFB 'connect'. Captures the configured sharp target and
     * keeps the first frame at COLD_QUALITY when the target allows it.
     *
     * If the refine timer fires while a scroll/typing burst still holds quality low,
     * it only marks the target as reached — restoreFor() then lands on `sharp` when
     * the burst settles, so refinement never fights the adaptive path.
     */
    beginRefine() {
      const rfb = getRfb();
      if (!rfb) return;
      const cur = rfb.qualityLevel;
      if (typeof cur !== 'number') return;
      sharp = cur;
      if (refineTimer !== null) { clearTimeout(refineTimer); refineTimer = null; }
      if (sharp <= COLD_QUALITY) { refined = true; return; } // nothing to defer
      refined = false;
      if (reasons.size === 0) write(COLD_QUALITY);
      refineTimer = setTimeout(() => {
        refineTimer = null;
        refined = true;
        if (reasons.size === 0) { write(sharp); dbg('quality refined -> ' + sharp); }
      }, REFINE_IDLE_MS);
    },

    // typing consumer — keyboard up on a slow link.
    lower: () => lowerFor('typing'),
    restore: () => restoreFor('typing'),

    // motion consumer — called on every forwarded scroll/drag frame (the /input
    // touchmove chokepoint, already gated on remoteTouchActive so client
    // pinch/pan never reach here). Lowers now (idempotent) and debounces the
    // restore so a continuous drag stays low and quality returns
    // MOTION_RESTORE_MS after the finger stops — covering the fling tail.
    // restoreFor('motion') keeps quality low if typing still owns the stash.
    noteMotion() {
      lowerFor('motion');
      if (motionTimer !== null) clearTimeout(motionTimer);
      motionTimer = setTimeout(() => { motionTimer = null; restoreFor('motion'); }, MOTION_RESTORE_MS);
    },

    // detach/reconnect: drop the stash + reasons without touching the (dead) rfb;
    // the next rfb reconnects at its configured quality and re-lowers on demand.
    resetSaved() {
      savedQuality = null; reasons.clear();
      if (motionTimer !== null) { clearTimeout(motionTimer); motionTimer = null; }
      // Refinement is per-connection: the next RFB arrives at its configured
      // quality and beginRefine() re-runs the cold-then-sharpen cycle. Leaving a
      // pending timer would step the NEW connection up early.
      if (refineTimer !== null) { clearTimeout(refineTimer); refineTimer = null; }
      sharp = null; refined = true;
    },
  };
}
