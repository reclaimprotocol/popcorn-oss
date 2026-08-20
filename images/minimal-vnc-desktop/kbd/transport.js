// transport.js — RFB keystroke transport (replaces CDP Input.*): text/special-key
// sends, per-burst WebSocket frame coalescing, and the reconnect keystroke queue.
//
// This is the hottest path in the layer — every keystroke from every IME handler
// routes through sendText/sendSpecialKey.
//
// Keystrokes typed while RFB is down (a 3G blip + the ~600ms auto-reconnect)
// would otherwise vanish. Hold them in a bounded queue and replay in order once
// RFB reattaches ('connect' → flushSendQueue). Bounded so a long outage can't
// grow unboundedly; dropped-too-old entries are skipped so we never replay stale
// text into a field the user has since moved on from.
//
// createTransport(deps): getRfb/getRfbReady are live accessors (rfb ownership
// stays in the core's attach/detach); echoAppend/echoBackspace are arrows onto
// the echo module; onSent(deltaCodepoints) feeds the core's drift-recon counter
// (positive for typed codepoints, negative for Backspaces — the core gates it
// on reconEnabled).

import { isTouch, nowMs } from './env.js';
import { fieldRejectsSpace } from './ime-hints.js';
import { dbg, dbgv, safeKeyName, KBD_LOG } from './diag.js';
import { e2e } from './e2e.js';
import { SPECIAL_KEYSYMS, keysymForCodepoint } from './keys.js';
import { reportInteraction } from './host-bridge.js';

const SEND_QUEUE_MAX = 128;
const SEND_QUEUE_MAX_AGE_MS = 5000;

export function createTransport({ getRfb, getRfbReady, echoAppend, echoBackspace, onSent, getFocusKey }) {
  let sendQueue = [];
  let replayingQueue = false; // true while flushSendQueue replays (don't re-echo)

  function enqueueSend(item) {
    item.ts = nowMs();
    // Tag with the field that was focused when this was typed. If the user moves
    // to a DIFFERENT field during the outage (a 3G blip + reconnect), replaying
    // these into the now-focused field would leak text across fields — e.g. a
    // search string typed pre-blip landing in a password field on reconnect.
    item.fk = getFocusKey ? getFocusKey() : null;
    sendQueue.push(item);
    while (sendQueue.length > SEND_QUEUE_MAX) sendQueue.shift();
  }
  function flushSendQueue() {
    if (!getRfb() || !getRfbReady() || !sendQueue.length) return;
    const items = sendQueue;
    sendQueue = [];
    const now = nowMs();
    // These items were already echoed optimistically when queued (during the
    // outage), so suppress the real path's re-echo — the sync.len reconcile
    // clears the pill once the replayed text lands.
    replayingQueue = true;
    try {
      const curFk = getFocusKey ? getFocusKey() : null;
      for (const it of items) {
        if (now - it.ts > SEND_QUEUE_MAX_AGE_MS) continue; // too stale to replay
        // DROP (don't re-target) keys typed for a different field than the one
        // focused now — the user moved on during the outage; replaying would
        // corrupt/leak into the wrong field. A null current fk (no field focused
        // after reconnect) also drops, since there's nowhere safe to replay.
        if (getFocusKey && it.fk !== curFk) continue;
        // rfb is set now, so these take the real send path (no re-queue).
        if (it.kind === 'text') sendText(it.payload);
        else sendSpecialKey(it.payload.name, it.payload.count);
      }
    } finally {
      replayingQueue = false;
    }
  }

  // Coalesce a burst of key events into ONE WebSocket frame. noVNC flushes the
  // socket after every keyEvent (rfb.js _sock.flush()), so a glide-typed word, a
  // paste, or an autocorrect delete-old+retype-new becomes dozens of tiny wss
  // frames — on lossy 3G that multiplies packets, loss probability, and radio
  // wakeups, and a mid-burst loss can strand the remote field half-edited.
  // Suspending the per-key flush lets all KeyEvents accumulate in noVNC's 10 KiB
  // send queue and go out atomically; RFB is a byte stream so the remote parses
  // the concatenated events identically. We still flush when the queue is nearly
  // full — sQpushBytes calls flush() to make room and would otherwise spin — and
  // if noVNC's internals ever change shape we fall back to the normal per-key
  // flush (correct, just not batched).
  function sendBatched(fn) {
    const rfb = getRfb();
    const sock = rfb && rfb._sock;
    if (!sock || typeof sock.flush !== 'function') { fn(); return; }
    const realFlush = sock.flush.bind(sock);
    sock.flush = function () {
      const len = sock._sQlen, cap = sock._sQbufferSize;
      if (typeof len !== 'number' || typeof cap !== 'number') { realFlush(); return; }
      if (cap - len < 64) realFlush(); // near-full: flush to keep space for more
      // else swallow — the end-of-burst flush below ships it as one frame
    };
    try { fn(); }
    finally {
      sock.flush = realFlush;
      try { realFlush(); } catch (_) {}
    }
  }

  // ---- carry-over space guard ------------------------------------------------
  // Moving from the username field to the password field put a SPACE in the
  // password before the first typed character, so the site rejected a correct
  // login ("incorrect email or password") — which reads exactly like an email
  // problem, and is what sent the earlier hunt after the email field.
  //
  // Where it comes from: tapping the next field makes Gboard commit the word it
  // was still composing for the PREVIOUS one, and that commit (word + its
  // auto-space) arrives after the remote has already moved focus. The
  // address-field filter can't stop it — by then the focused field is the
  // password, where we deliberately allow spaces because passphrase spaces are
  // legal. The cross-field buffer reset in field-session can't stop it either:
  // it is keyed on focusKey changing, and the device log shows focusKey constant
  // (fk=fihg0n:2) across the whole session, so `isNewField` never fires.
  //
  // So guard it here, at the single funnel every send path goes through, on a
  // local signal that needs neither sync.val (absent — the log shows `val=-`) nor
  // a correct focusKey: the FIRST character of a field session is never a space.
  // Armed by a raise/dismiss, by Tab, and by a focusKey change; disarmed by the
  // first real character.
  //
  // TWO HARD LIMITS, because a password can legitimately START with a space and
  // stripping it would produce a failed login with NO feedback — invisible field,
  // and drift-recon is off on secrets, so the corruption is undetectable. That is
  // the same class of bug this guard exists to fix, so it must not create one.
  // autospace.js refuses to touch sensitive fields for exactly this reason.
  //
  //  1. TIME-BOUNDED. The carry-over is CAUSED by the focus change, so it arrives
  //     essentially instantly — it's a local IME event, not a network one, so this
  //     window doesn't stretch on a slow link. A user reaching for the space bar
  //     can't beat the keyboard's own raise animation, so their deliberate leading
  //     space (in a password or anywhere else) falls outside the window and is
  //     sent. Only the machine-fast space is dropped.
  //  2. SOFT KEYBOARDS ONLY. A physical keyboard has no cross-field IME commit,
  //     and a desktop typist CAN legitimately hit space within the window — so
  //     there is risk and no benefit. Excluded.
  const CARRYOVER_WINDOW_MS = 600;
  let freshField = true;
  let freshFieldAt = 0;
  let lastSendFk = null;
  // Content-free session progress marker for diagnosing partial or repeated
  // IME delivery. Counts only code points actually forwarded to RFB.
  let sessionCharsSent = 0;
  let textLogEvents = 0, textLogSent = 0, textLogFiltered = 0, textLogTimer = null;

  // IMEs can deliver one event per character. Batch their diagnostic accounting
  // into a short summary rather than adding a log POST for every keystroke.
  function flushTextLog() {
    textLogTimer = null;
    if (!textLogEvents) return;
    dbg('text send events=' + textLogEvents + ' sent=' + textLogSent +
      ' total=' + sessionCharsSent + (textLogFiltered ? ' filtered=' + textLogFiltered : '') +
      ' rfb=ready');
    textLogEvents = 0;
    textLogSent = 0;
    textLogFiltered = 0;
  }
  function noteTextLog(requested, sent) {
    if (!KBD_LOG) return;
    textLogEvents++;
    textLogSent += sent;
    textLogFiltered += Math.max(0, requested - sent);
    if (textLogTimer === null) textLogTimer = setTimeout(flushTextLog, 750);
  }

  // True only for a space we can attribute to the IME's cross-field flush.
  function carryOverSpace() {
    return freshField && isTouch && (nowMs() - freshFieldAt) < CARRYOVER_WINDOW_MS;
  }

  function noteFieldReset() {
    freshField = true;
    freshFieldAt = nowMs();
  }

  function sendText(text) {
    if (!text) return;
    const rfb = getRfb();
    if (!rfb || !getRfbReady()) { dbg('sendText queued (rfb down) len=' + text.length); echoAppend(text); enqueueSend({ kind: 'text', payload: text }); return; }
    // A focus move is a fresh field even when the page reuses the same focusKey.
    const fk = getFocusKey ? getFocusKey() : null;
    if (fk !== lastSendFk) { lastSendFk = fk; noteFieldReset(); }
    // Redacted shape only — never content. Between them, `sp`/`nospace`/`carry`
    // say whether a payload ends in a space, whether the address filter is armed,
    // and whether the carry-over guard is — the three questions the auto-space
    // bug turned on.
    dbgv('sendText chars=' + text.length + ' sp=' + (/ $/.test(text) ? 1 : 0) +
         ' nospace=' + (fieldRejectsSpace() ? 1 : 0) + ' carry=' + (carryOverSpace() ? 1 : 0));
    let sent = 0;
    sendBatched(() => {
      // Iterate by code point so surrogate pairs / emoji send as one keysym.
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        // Tab / LF / CR are the only control chars we forward, but they need their
        // dedicated X11 keysyms — keysymForCodepoint() would encode them as the
        // bogus 0x0100000{9,a,d}, which the remote renders as nothing (or a
        // literal control char). Route them through the special-key keysyms.
        // Tab ends the field, so re-arm the guard for the next one (tabbing between
        // fields is the same hazard as tapping into them). Enter deliberately does
        // NOT re-arm: in a textarea it's a newline, not a field change, and
        // re-arming would drop the first space of every new line — silently eating
        // indentation.
        if (cp === 0x0a || cp === 0x0d) { try { rfb.sendKey(SPECIAL_KEYSYMS.Enter, 'Enter'); sent++; } catch (_) {} continue; }
        if (cp === 0x09) { try { rfb.sendKey(SPECIAL_KEYSYMS.Tab, 'Tab'); sent++; noteFieldReset(); } catch (_) {} continue; }
        if (cp < 0x20) continue; // skip other control chars
        // Gboard commits `word` + SPACE when you tap a suggestion. On an address-like
        // field that trailing space is invisible and makes the site reject a correct
        // value ("incorrect email or password"). It reaches us because the proxy is
        // always type=text — setSelectionRange throws on type=email, see ime-hints —
        // so the keyboard treats the field as prose no matter what inputmode says.
        // Dropping the space here catches every source (suggestion commit, glide,
        // typing it by hand), and never applies to password fields.
        if (cp === 0x20 && fieldRejectsSpace()) { dbgv('space dropped (address field)'); continue; }
        // Carry-over from the previous field (see the note above): the first
        // character of a fresh field session can't legitimately be a space.
        // Normal tier — this one is the P1, so it must be visible without
        // ?kbddebug=1.
        if (cp === 0x20 && carryOverSpace()) { dbg('leading space dropped (field carry-over)'); continue; }
        try { rfb.sendKey(keysymForCodepoint(cp), null); sent++; freshField = false; } catch (_) {}
      }
    });
    onSent(sent);
    sessionCharsSent += sent;
    noteTextLog(text.length, sent);
    // One 'char' per CALL, not per code point — parity with the CDP path a host
    // may have used before (Input.insertText counted once regardless of length),
    // so a paste or an IME batch doesn't inflate a host's typing metrics.
    if (sent > 0) reportInteraction('char');
    // Typing has no per-keystroke acknowledgement to wait for (keysyms go over
    // RFB, which is fire-and-forget), so the trace runs send -> paint: exactly the
    // "I typed and the character showed up later" complaint, measured.
    if (sent > 0) e2e.noteSent('text', 'n=' + sent, false);
    if (sent > 0 && !replayingQueue) echoAppend(text); // optimistic local echo (already echoed on the queued path)
  }

  function sendSpecialKey(name, count) {
    count = count == null ? 1 : count;
    if (count <= 0) return;
    const keysym = SPECIAL_KEYSYMS[name];
    if (!keysym) return;
    const rfb = getRfb();
    if (!rfb || !getRfbReady()) { dbg('sendKey queued (rfb down)'); if (name === 'Backspace') echoBackspace(count); enqueueSend({ kind: 'special', payload: { name, count } }); return; }
    dbgv('sendKey ' + name + 'x' + count);
    if (count > 1) {
      sendBatched(() => { for (let i = 0; i < count; i++) { try { rfb.sendKey(keysym, name); } catch (_) {} } });
    } else {
      try { rfb.sendKey(keysym, name); } catch (_) {}
    }
    dbg('key send name=' + safeKeyName(name) + ' count=' + count + ' rfb=ready');
    // safeKeyName, never the raw key: a trace tag must not be able to carry a
    // printable character.
    e2e.noteSent('key', safeKeyName(name), false);
    // Once per repeat: a held backspace would have been N dispatchKeyEvents on the
    // CDP path, so N is what a host's counters expect. safeKeyName is belt-and-
    // braces — these are always named keys, never printable characters.
    for (let i = 0; i < count; i++) reportInteraction('special', safeKeyName(name));
    // Tab leaves the field — re-arm the carry-over space guard for the next one.
    // NOT Enter (a textarea newline is not a field change; see the note in
    // sendText). Backspace neither disarms nor re-arms it: once the user has typed
    // a real character, a space they type after deleting back to empty is their
    // own, and this guard's business is only the IME's cross-field carry-over.
    if (name === 'Tab') noteFieldReset();
    if (name === 'Backspace') onSent(-count);
    if (name === 'Backspace' && !replayingQueue) echoBackspace(count); // keep the echo in sync (already echoed on the queued path)
  }

  return { sendText, sendSpecialKey, flushSendQueue, noteFieldReset,
           queueLength: () => sendQueue.length };
}
