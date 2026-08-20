// e2e.js — opt-in, privacy-safe input-to-paint latency tracing.

import { nowMs } from './env.js';
import { dbg, KBD_LOG } from './diag.js';

// How many traces per page load. A handful is enough to characterise a session:
// the first tap after load, the first field, a few keystrokes. Unbounded tracing
// on a phone would be its own performance story.
const DEFAULT_TRACES = 8;
// Give up on a paint this long after the input. Past this the answer is "nothing
// visibly changed", which is itself the finding — a lost keystroke, a remote that
// never repainted, a stalled decoder.
const PAINT_BUDGET_MS = 2500;
// After the pixels arrive, how much longer to wait for the REMOTE confirmation.
// The two legs are independent and usually land in that order: the framebuffer
// repaints as soon as the remote page redraws, while the field's value-length
// report travels over /kbd and is debounced at the extension. Closing the trace
// on the first paint therefore reported `remote=-` on essentially every keystroke
// — the leg was there and never populated, which is worse than not having it.
const REMOTE_BUDGET_MS = 1500;
// Paint poll interval. Not requestAnimationFrame: a backgrounded or throttled
// frame stops getting those, and the trace would silently never resolve.
const POLL_MS = 50;
// Patch grid sampled per poll.  A 3x3 grid could entirely miss a localized input
// update, producing a misleading `paint=none` result.  This denser 5x5 grid of
// 12x12 patches covers 3,600 sampled pixels (still bounded and opt-in), while
// leaving the raw pixels in-memory only long enough to update the checksum.
const PATCH = 12;
const GRID = 5;
// WHERE to sample, when we know. A uniform grid is the wrong shape for the event
// this tracer exists to time: typing changes a caret and a few characters inside
// one field, and a 5x5 grid of 12px patches lands between them. Measured on an
// emulated Pixel 7 against a real pod, 3 of ~12 text traces reported
// `paint=none>2500ms` while the characters were demonstrably on screen — a false
// "lost keystroke" in the one diagnostic somebody would quote to prove the
// keyboard is broken.
//
// The viewer already knows the focused field's rect in REMOTE pixels (the
// extension reports it on /kbd), and remote pixels ARE framebuffer pixels — the
// canvas holds the framebuffer, which is why tap.js can map a touch to a remote
// coordinate 1:1. So when a field is focused, sample a band across THAT rect and
// keep the grid only as the fallback for taps, scrolls and everything else.
//
// Rows sampled across the field, and the width of each row's sample. The row
// count is what catches a caret blink and a one-character change; the cap keeps
// the readback bounded on a wide field.
const FIELD_ROWS = 6;
const FIELD_MAX_W = 320;

export const E2E_TRACES = (function () {
  try {
    const raw = new URLSearchParams(location.search).get('e2e');
    if (raw === null) return 0;
    if (raw === '1' || raw === 'true') return DEFAULT_TRACES;
    const n = parseInt(raw, 10);
    return isFinite(n) && n > 0 ? Math.min(n, 100) : 0;
  } catch (_) { return 0; }
})();

// Tracing writes through dbg(), so it needs the log tier on. ?e2e=1 does not
// silently imply it — an operator asking for latency traces on a session with
// diagnostics off would get nothing and no explanation, so say so once.
export const E2E_ON = E2E_TRACES > 0;

export function createE2E({ getScreenElement, getFieldRect }) {
  let budget = E2E_TRACES;
  let active = null;   // the one in-flight trace
  let pending = 0;     // stamp of the physical input, before anything was sent
  let warned = false;

  function enabled() {
    if (!E2E_ON) return false;
    if (!KBD_LOG) {
      if (!warned) { warned = true; try { if (window.console) console.warn('[kbd] ?e2e= needs ?diag=1 (or ?kbddebug=1) to have somewhere to log'); } catch (_) {} }
      return false;
    }
    return budget > 0;
  }

  // Checksum of a sparse patch grid. Deliberately lossy and deliberately
  // one-way: the return value is a single number that says nothing about the
  // image beyond "these bytes differ from last time".
  // The focused field as a list of {x,y,w,h} sample bands in canvas pixels, or
  // null when no field is focused / the rect does not intersect the framebuffer.
  // Clamped to the canvas on every axis: a rect can legitimately sit partly
  // off-screen (a field under the keyboard, mid-pan), and getImageData throws
  // rather than clipping.
  function fieldBands(canvas) {
    let r = null;
    try { r = getFieldRect && getFieldRect(); } catch (_) { return null; }
    if (!r || !(r.w > 0) || !(r.h > 0)) return null;
    const x0 = Math.max(0, Math.min(canvas.width - 1, Math.round(r.x)));
    const y0 = Math.max(0, Math.min(canvas.height - 1, Math.round(r.y)));
    const w = Math.max(1, Math.min(FIELD_MAX_W, Math.round(r.w), canvas.width - x0));
    const hh = Math.max(1, Math.min(Math.round(r.h), canvas.height - y0));
    if (w < 2 || hh < 2) return null;
    const bands = [];
    const rows = Math.min(FIELD_ROWS, hh);
    for (let i = 0; i < rows; i++) {
      const y = y0 + Math.min(hh - 1, Math.round((i + 0.5) * hh / rows));
      bands.push({ x: x0, y, w, h: 1 });
    }
    return bands;
  }

  // The uniform fallback: for a tap, a scroll or a navigation the change can be
  // anywhere, so spread the budget over the whole framebuffer.
  function gridBands(canvas) {
    const bands = [];
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        bands.push({
          x: Math.min(canvas.width - PATCH, Math.max(0, Math.round((gx + 0.5) * canvas.width / GRID) - (PATCH >> 1))),
          y: Math.min(canvas.height - PATCH, Math.max(0, Math.round((gy + 0.5) * canvas.height / GRID) - (PATCH >> 1))),
          w: PATCH, h: PATCH,
        });
      }
    }
    return bands;
  }

  // Which sampling shape the in-flight trace is using, for the log line — a
  // `paint=none` from a field sample and one from a grid sample mean different
  // things, and the reader cannot tell them apart otherwise.
  function bandsFor(canvas, kind) {
    if (kind === 'text' || kind === 'key') {
      const f = fieldBands(canvas);
      if (f) return { bands: f, where: 'field' };
    }
    return { bands: gridBands(canvas), where: 'screen' };
  }

  function screenChecksum(kind, out) {
    const screen = getScreenElement && getScreenElement();
    const canvas = screen && screen.querySelector && screen.querySelector('canvas');
    if (!canvas || !canvas.width || !canvas.height) return null;
    let ctx;
    try { ctx = canvas.getContext('2d'); } catch (_) { return null; }
    if (!ctx || typeof ctx.getImageData !== 'function') return null;
    const sel = bandsFor(canvas, kind);
    if (out) out.where = sel.where;
    let h = 0x811c9dc5;
    try {
      for (const b of sel.bands) {
        const d = ctx.getImageData(b.x, b.y, b.w, b.h).data;
        // Stride 4: one byte per pixel is plenty to notice a repaint, and it
        // quarters the work.
        for (let i = 0; i < d.length; i += 4) {
          h ^= d[i];
          h = (h * 0x01000193) >>> 0;
        }
      }
    } catch (_) { return null; }   // 0-size canvas mid-resize, or a lost context
    return h;
  }

  // A trace ends when every leg it is entitled to has either landed or timed out.
  // For a tap that is the paint; for text it is the paint AND the remote
  // confirmation, whichever way round they arrive.
  function maybeFinish(trace) {
    if (active !== trace) return;
    if (!trace.paintDone) return;
    if (trace.kind === 'text' && !trace.remote && !trace.remoteDone) return;
    if (trace.remoteTimer) { clearTimeout(trace.remoteTimer); trace.remoteTimer = null; }
    finish(trace, trace.paint);
  }

  function notePaint(trace, paintAt) {
    if (active !== trace || trace.paintDone) return;
    trace.paintDone = true;
    trace.paint = paintAt;
    // Give the confirmation its own bounded window, starting now rather than at
    // the input — it cannot be reported before the remote has actually applied the
    // keystroke, so timing it from the paint is what makes the budget meaningful.
    if (trace.kind === 'text' && !trace.remote) {
      trace.remoteTimer = setTimeout(() => {
        trace.remoteTimer = null;
        trace.remoteDone = true;
        maybeFinish(trace);
      }, REMOTE_BUDGET_MS);
    }
    maybeFinish(trace);
  }

  function finish(trace, paintAt) {
    if (active !== trace) return;
    active = null;
    const at = (t) => (t ? '+' + Math.round(t - trace.t0) + 'ms' : '-');
    dbg('e2e ' + trace.kind + ' ' + trace.tag +
      ' sent=' + at(trace.sent) +
      ' written=' + at(trace.written) +
      // The REMOTE leg: the extension has reported the field's own value length
      // growing by what we sent, i.e. the characters are in the remote input —
      // not merely on the wire. See noteRemoteConfirm().
      (trace.kind === 'text' ? ' remote=' + at(trace.remote) : '') +
      ' paint=' + (paintAt ? at(paintAt) : 'none>' + PAINT_BUDGET_MS + 'ms') +
      (paintAt ? '' : '@' + (trace.where || '?')) +
      ' total=' + Math.round((paintAt || nowMs()) - trace.t0) + 'ms', true);
  }

  // Watch for the next visible framebuffer change. Started at the last leg we
  // have a signal for (the proxy ack when there is one, the send otherwise), so
  // the paint number is never inflated by a leg we already measured separately.
  function watchPaint(trace) {
    const meta = {};
    let base = screenChecksum(trace.kind, meta);
    trace.where = meta.where;
    if (base === null) { notePaint(trace, 0); return; }
    const started = nowMs();
    const poll = () => {
      if (active !== trace) return;
      if (trace.paintDone) return;
      const now = screenChecksum(trace.kind, meta);
      // The sampled REGION can change under us mid-trace (the field scrolls, the
      // lift moves it, focus lands elsewhere). Comparing a field checksum against
      // a grid checksum would report a paint that never happened, so a change of
      // shape re-baselines instead of resolving.
      if (meta.where !== trace.where) {
        trace.where = meta.where;
        // A new sampling region has a different checksum by definition. Keep it
        // as the baseline so the region change itself is not reported as paint.
        if (now !== null) base = now;
        return void setTimeout(poll, POLL_MS);
      }
      if (now !== null && now !== base) { notePaint(trace, nowMs()); return; }
      if (nowMs() - started >= PAINT_BUDGET_MS) { notePaint(trace, 0); return; }
      setTimeout(poll, POLL_MS);
    };
    setTimeout(poll, POLL_MS);
  }

  return {
    /**
     * The physical input happened. Called from the gesture/IME handler BEFORE
     * anything is queued, so the trace starts where the user's action did rather
     * than where our plumbing did. Cheap enough to call unconditionally.
     */
    noteInput() {
      if (!enabled()) return;
      pending = nowMs();
    },

    /**
     * We handed the input to a transport. `tag` is the existing diagnostic id
     * ('g#7' for a gesture) so a trace can be lined up with the input log.
     * ack=false starts the paint watch immediately (RFB key/text sends have no
     * acknowledgement to wait for).
     */
    noteSent(kind, tag, ack) {
      if (!enabled()) return;
      if (active) return;             // one at a time; the next input gets a turn
      budget--;
      const t = nowMs();
      active = { kind, tag: tag || '-', t0: pending || t, sent: t, written: 0, remote: 0,
                 paint: 0, paintDone: false, remoteDone: false, remoteTimer: null, where: '' };
      pending = 0;
      if (!ack) watchPaint(active);
    },

    /**
     * The proxy acknowledged writing the CDP command for `tag` (see ackInput in
     * proxy/emulate.go). Only 'written' arms the paint watch; a 'not-written' or
     * 'rejected' outcome closes the trace with the reason, because there is no
     * paint coming and waiting 2.5s for one would hide the real finding.
     */
    noteWritten(tag, state) {
      if (!active || active.written || active.tag !== tag) return;
      active.written = nowMs();
      if (state !== 'written') { const t = active; dbg('e2e ' + t.kind + ' ' + t.tag + ' proxy=' + (state || '-') + ' — no paint expected', true); active = null; return; }
      watchPaint(active);
    },

    /**
     * The REMOTE field has confirmed the characters. Typing does not travel on
     * the /input channel and has no proxy write to acknowledge — keysyms go
     * straight down the RFB tunnel — so `written` is always '-' for text and the
     * trace could not distinguish "the keystroke never arrived" from "it arrived
     * and the repaint was slow". Those have opposite fixes, and it is the single
     * most common thing a user reports.
     *
     * The confirmation already exists in the stream we were not reading: the
     * extension reports the focused field's own value LENGTH on /kbd, and
     * field-session already reconciles it against what we sent (its drift
     * counter). When that reconciliation says the remote field grew by what we
     * typed, the characters are demonstrably in the remote input. That is a
     * stronger statement than a write ack, so it is worth more than the leg it
     * replaces.
     *
     * Sensitive fields report no length at all (by design — see content.js), so
     * `remote` simply stays '-' there. The paint watch is unaffected either way:
     * it starts at send time for text and this only annotates the trace.
     */
    noteRemoteConfirm() {
      if (!active || active.kind !== 'text' || active.remote) return;
      active.remote = nowMs();
      maybeFinish(active);
    },

    /** For tests and for a manual console poke. */
    inFlight: () => !!active,
    remaining: () => budget,
  };
}

// One instance per page, reachable from the three modules that see the legs
// (kbd/tap.js, kbd/touch-channel.js, kbd/transport.js) without threading a dep
// through each of their factories. Every accessor is a no-op until initE2E runs,
// and initE2E is skipped entirely when the flag is absent — so the un-traced path
// is one null check per input event.
let instance = null;

export function initE2E(deps) {
  if (!E2E_ON) return null;
  instance = createE2E(deps);
  return instance;
}

export const e2e = {
  noteInput() { if (instance) instance.noteInput(); },
  noteSent(kind, tag, ack) { if (instance) instance.noteSent(kind, tag, ack); },
  noteWritten(tag, state) { if (instance) instance.noteWritten(tag, state); },
  noteRemoteConfirm() { if (instance) instance.noteRemoteConfirm(); },
  active: () => !!instance,
};
