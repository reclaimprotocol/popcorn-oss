// health.js — privacy-safe integration health events for the embedding host.

import { dbg } from './diag.js';
import { nowMs } from './env.js';
import { postToHost } from './host-bridge.js';

// Re-report a still-true condition this often. Long enough that a persistent
// problem does not spam the embedder's log, short enough that a host mounting its
// listener late still hears about it.
const REPEAT_MS = 30000;
const CODES = new Set([
  'host-geometry-blind', 'host-geometry-stale', 'host-geometry-disagrees',
  'host-occlusion-not-ours',
  'focus-stolen', 'no-virtual-keyboard', 'remote-unconfirmed',
]);

const seen = new Map();   // code -> last reported at
const everSeen = [];      // insertion-ordered, for the cumulative payload

/**
 * Report a structural integration problem, at most once per REPEAT_MS per code.
 *
 * `detail` is an optional object of NUMBERS only (heights, counts, ages) — it is
 * forwarded verbatim, so anything that could carry content must not be passed.
 * Callers pass measurements; there is no string field by design.
 */
export function reportHealth(code, detail) {
  if (!CODES.has(code)) return false;
  const now = nowMs();
  const last = seen.get(code) || 0;
  if (last && now - last < REPEAT_MS) return false;
  seen.set(code, now);
  if (everSeen.indexOf(code) < 0) everSeen.push(code);
  const nums = {};
  if (detail) {
    for (const k of Object.keys(detail)) {
      const v = detail[k];
      if (typeof v === 'number' && isFinite(v)) nums[k] = Math.round(v);
    }
  }
  dbg('health ' + code + (Object.keys(nums).length
    ? ' ' + Object.keys(nums).map((k) => k + '=' + nums[k]).join(' ')
    : ''), true);
  postToHost('POPCORN_KBD_HEALTH', { code, detail: nums, codes: everSeen.slice() });
  return true;
}

/** Codes reported so far this page load (for tests and a console poke). */
export function healthCodes() { return everSeen.slice(); }

/** Test seam: forget everything, so each case starts from a clean session. */
export function resetHealth() { seen.clear(); everSeen.length = 0; }
