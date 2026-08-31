// ime-input.js — the per-platform IME input state machine (ported from the neko
// chromium-headful client's video.vue, then hardened here; see kbd-autofocus.js
// header for the transport story).
//
// Owns EVERYTHING about translating soft-keyboard/IME events into remote
// keystrokes: the iOS beforeinput path (incl. the chew buffer and iosWord
// autocorrect tracking), the Android hidden-<input> value-diff path, the
// EditContext path (SwiftKey re-compose reconcile, deferred Unidentified
// backspace), CJK composition, the minimal-diff sender, and mirror-mode
// seeding. All composition/buffer flags are module-private; the few the rest
// of the layer needs are exposed as getters (composing / lastInputAt / ecMode)
// or verbs (resetComposition / clearProxy / seedProxyMirror / adoptRemoteValue).
//
// The proxy element and the EditContext are created by setup() and handed in
// via setProxy/setEcMode/setEditContext, so the moved code keeps referring to
// plain `proxy`/`editCtx` locals (no accessor rewrites on the hot paths).
//
// Callbacks into the core: onInput (latch keyboardActive + watchdog),
// onSystemBlur (system back/swipe dismiss teardown), onMirrorSeedConsumed
// (typing began — stop late seeds), getSensitiveField / getRemoteValue
// (field-session state), sendActionKey (clipboard), toggleKeyboard (hoisted).

import { isAndroid, isIOS, MIRROR, nowMs } from './env.js';
import { dbg, dbgv, safeKeyName } from './diag.js';
import { isHighSurrogate, isLowSurrogate, backspaceCountFor } from './keys.js';
import { linkLatency } from './latency.js';
import { stripCtl } from './echo.js';
import { e2e } from './e2e.js';

export function createImeInput({
  getRfb, sendText, sendSpecialKey, sendActionKey, echo, filterAutoSpace, toggleKeyboard,
  getSensitiveField, getRemoteValue, onMirrorSeedConsumed, onInput, onSystemBlur,
}) {
  let proxy = null;              // hidden <input>/<div> the OS IME composes into (set by setup)
  let ecMode = false;            // using the EditContext API (Chromium/Android)
  let editCtx = null;            // the EditContext instance (when ecMode)
  // EditContext's updateRange offsets are UTF-16 indices into the PRE-update
  // buffer. Keep that buffer so deletion can use the same grapheme-aware
  // Backspace count as the other mobile paths. Sending the raw range length
  // makes a single emoji deletion send two Backspaces and eat the character
  // before it.
  let ecText = '';

  let lastSentValue = '';        // what we've already forwarded to the remote
  let pendingBackspaceTimer = null; // Indic 'Unidentified' deferred backspace
  let isComposing = false;
  let composedSuppressed = false; // <input> path withheld composing sends (slow link)
  let ecSuppressed = false;       // EC path withheld composing sends (slow link)
  let composedForwarded = false;  // a composition step already sent its text (iOS) —
                                  // so compositionend must not re-send on empty .data
  let ecCommittedWord = false;    // an unfinished word was committed NON-composing on
                                  // the EC path (SwiftKey commits each key, then
                                  // re-composes/autocorrects the whole word on space);
                                  // cleared at a word boundary / field change
  let ecComposeReconciled = false; // this EC composition's re-grab was already checked
  let lastProxyInputAt = 0;       // last soft-keyboard input — floating/split kbd proof
  let firstImeEvent = null;       // diagnostic evidence of which browser input API actually fired

  // Android does not expose the installed keyboard app (Gboard, SwiftKey,
  // Samsung Keyboard, etc.). The browser event path is actionable for debugging input delivery and contains no user data.
  function noteImeEvent(path) {
    if (firstImeEvent) return;
    firstImeEvent = path;
    dbg('ime first-event=' + path);
  }

  // Minimal edit from oldV -> newV keeping the common PREFIX (the remote caret is
  // at the end of oldV, so we can only safely edit the tail without moving it):
  // backspace just the changed old tail, type just the changed new tail. Turns
  // Korean jamo ('가나다라'->'가나다랄'), Vietnamese tone marks, and Japanese
  // candidate cycling from O(2N) key events into O(changed) — big on 3G where each
  // keysym is echoed back as a video delta. Surrogate-safe (won't split a pair).
  function diffAndSend(oldV, newV) {
    let p = 0;
    const maxP = Math.min(oldV.length, newV.length);
    while (p < maxP && oldV[p] === newV[p]) p++;
    if (p > 0 && p < oldV.length &&
        isHighSurrogate(oldV.charCodeAt(p - 1)) && isLowSurrogate(oldV.charCodeAt(p))) p--;
    const oldTail = oldV.slice(p);
    const newTail = newV.slice(p);
    if (oldTail) sendSpecialKey('Backspace', backspaceCountFor(oldTail));
    if (newTail) {
      const f = isComposing ? newTail : filterAutoSpace(newTail);
      // Which branch carried the text, and whether it ended in a space. This is
      // what ruled the value-diff OUT of the Gboard auto-space bug (it never
      // logged), pointing at the cross-field carry-over instead — see the guard in
      // transport.js. Shape only, no content.
      dbgv('diff tail=' + newTail.length + ' sp=' + (/ $/.test(newTail) ? 1 : 0) +
           ' comp=' + (isComposing ? 1 : 0) + ' after=' + (f ? f.length : 0));
      if (f) sendText(f);
    }
  }

  // Caret keys, shared by both mobile paths. Previously inert — swallowed and
  // never forwarded — which silently corrupted the field for any keyboard that
  // has them (Hacker's Keyboard ships arrows, Home/End and Delete on a phone):
  // the local caret moved, the remote's did not, and the next edit diffed
  // against a tail the remote was no longer writing behind.
  //
  // Forwarding alone is not enough. The value-diff is anchored to the END of the
  // field, so once the caret moves, lastSentValue describes text the remote caret
  // no longer sits behind. Drop the baseline with the caret: the two now agree,
  // and the characters after it go out as plain inserts at the shared position.
  // Costs the IME its word context, which a word boundary costs anyway.
  const CARET_KEYS = new Set([
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Delete',
  ]);
  function handleCaretKey(e) {
    if (!CARET_KEYS.has(e.key)) return false;
    e.preventDefault();
    sendSpecialKey(e.key);
    clearProxy();
    return true;
  }

  // Commit-only composition: on a slow link, don't mirror every marked-text step
  // to the remote (that floods the tunnel with backspace/retype per jamo/kana and
  // fires the remote page's per-keystroke JS with half-composed text). Preview
  // locally and send the committed text once at compositionend.
  function commitOnly() { return linkLatency() > 700; }


  // Composition state, derived from ALL available signals — not just the
  // compositionstart listener. Samsung Keyboard and several Chinese IMEs fire
  // input/beforeinput with inputType='insertCompositionText' WITHOUT a preceding
  // compositionstart, so relying on the module flag alone misses them and the
  // intermediate marked text leaks to the remote as garbage. event.isComposing
  // is the authoritative per-event signal; fold it back into the module flag so
  // downstream keydown handlers (which get no inputType) also see it.
  function eventComposing(e) {
    const t = e && typeof e.inputType === 'string' ? e.inputType : '';
    const c = isComposing || (e && e.isComposing === true) ||
      t === 'insertCompositionText' || t === 'deleteCompositionText' || t === 'insertFromComposition';
    if (c) isComposing = true;
    return c;
  }

  // A soft-keyboard text event PROVES the keyboard is up — the one signal that
  // cannot lie. Floating/split keyboards (Gboard floating, Samsung split, iPad
  // floating) occlude nothing, so the geometric detectors (VK height / viewport
  // shrink) report "no keyboard" and would refuse to raise or, worse, dismiss a
  // working one. Stamp the time and, on touch, latch keyboardActive from here.
  function noteProxyInput() {
    lastProxyInputAt = nowMs();
    onInput(); // core: latch keyboardActive + start the watchdog (touch only)
  }

  // iOS: we clear the proxy on every keystroke, so track the current word here.
  // A tapped/auto autocorrect suggestion fires beforeinput 'insertReplacementText'
  // to replace that word — but the emptied proxy gives iOS nothing to replace, so
  // we reproduce the replace on the remote (backspace the old word, type the new).
  let iosWord = '';
  function trackIosWord(text) {
    for (const ch of (text || '')) {
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') iosWord = '';
      else iosWord += ch;
    }
  }

  // iOS hold-to-repeat backspace. iOS only auto-repeats delete while the field
  // actually SHRINKS; because we keep the proxy empty, a held backspace deletes
  // once and stops. After the first delete we seed an INVISIBLE chew buffer of
  // zero-width joiners and stop preventing the deletes, so each repeat tick eats
  // one buffer char — onProxyInput counts the shrink, sends that many remote
  // Backspaces, and refills to keep the hold alive. The buffer lives only during
  // a delete streak (torn down by the next insert via clearIosBuf) so normal
  // typing / autocorrect always see an empty field. iOS <input> path only.
  const IOS_BUF_CH = String.fromCharCode(0x2060); // WORD JOINER: zero-width, one code point each
  const IOS_BUF_N = 120;
  let iosBuf = false;
  function fillIosBuf() {
    if (isAndroid || !proxy || proxy.tagName !== 'INPUT') return;
    iosBuf = true;
    proxy.value = IOS_BUF_CH.repeat(IOS_BUF_N);
    try { proxy.setSelectionRange(IOS_BUF_N, IOS_BUF_N); } catch (_) {}
  }
  function clearIosBuf() {
    iosBuf = false;
    if (proxy && 'value' in proxy) proxy.value = '';
  }
  function trimIosWord(n) {
    const wc = Array.from(iosWord);
    iosWord = wc.slice(0, Math.max(0, wc.length - n)).join('');
  }

  function onProxyBeforeInput(e) {
    if (!getRfb() || !proxy) return;
    // Stamp the DOM input boundary, before IME/value-diff processing.  The
    // transport later records its send time, so an e2e text trace includes the
    // local processing a user experiences rather than starting at sendKey.
    e2e.noteInput();
    noteProxyInput();
    const inputType = e.inputType;
    noteImeEvent('beforeinput:' + (inputType || '-'));
    const data = e.data;
    dbgv('beforeinput type=' + inputType + ' dlen=' + (data ? data.length : 0) +
      ' comp=' + (isComposing || e.isComposing ? 1 : 0) + ' vlen=' + proxy.value.length);

    // Mirror mode routes iOS through the same value-diff contract as Android: DON'T
    // preventDefault ordinary inserts/deletes — let the OS mutate the populated
    // field naturally (that's what makes autocorrect/suggestions work), then diff
    // the value in onProxyInput. Only the two cases the value can't express are
    // handled here: a backspace on an empty field (nothing to delete locally) and
    // Enter (a single-line <input> swallows the newline).
    if (isAndroid || mirrorOn()) {
      if (inputType === 'deleteContentBackward' || inputType === 'deleteByCut' ||
          inputType === 'deleteContent' || inputType === 'deleteContentForward') {
        if (pendingBackspaceTimer !== null) { clearTimeout(pendingBackspaceTimer); pendingBackspaceTimer = null; }
        if (proxy.value === '') { e.preventDefault(); sendSpecialKey('Backspace'); return; }
        return;
      }
      // Any non-deletion input cancels the pending Unidentified backspace.
      if (pendingBackspaceTimer !== null) { clearTimeout(pendingBackspaceTimer); pendingBackspaceTimer = null; }
      if (inputType === 'insertLineBreak') {
        e.preventDefault();
        sendActionKey();
        proxy.value = '';
        lastSentValue = '';
      }
      return;
    }

    // iOS path — beforeinput is the source of truth.
    if (inputType === 'insertText' && data) {
      // NOTE: do NOT treat a multi-char insertText as a word replacement (tried
      // for suggestion taps): glide/QuickPath typing ALSO delivers the word as
      // one multi-char insertText, and backspacing iosWord first deletes the
      // text typed before the glide. Suggestion taps are instead prevented at
      // the source (QuickType is forced off on the proxy — see applyHints).
      sendText(data);          // whole batch in one shot (voice/glide/autocorrect)
      trackIosWord(data);
      if (isComposing) composedForwarded = true; // compositionend must not re-send
      e.preventDefault();
      clearIosBuf();           // typing ends any delete streak -> clean empty field
    } else if (inputType === 'insertReplacementText' && data != null) {
      // Autocorrect / tapped suggestion ("Tes" -> "Testing"): replace the current
      // word on the remote — backspace what we sent for it, then send the pick.
      e.preventDefault();
      const bs = backspaceCountFor(iosWord);
      if (bs > 0) sendSpecialKey('Backspace', bs);
      iosWord = '';
      if (data) { sendText(data); trackIosWord(data); if (isComposing) composedForwarded = true; }
      clearIosBuf();
    } else if (inputType === 'deleteContentBackward') {
      if (iosBuf && proxy.value.length > 0) {
        // Repeat tick of a HELD backspace: let iOS actually eat a buffer char (do
        // NOT preventDefault) so the field shrinks and the hold keeps repeating;
        // onProxyInput counts the shrink and sends the remote Backspace(s).
        return;
      }
      // First delete (empty field): send it now, then seed the chew buffer so a
      // held key repeats from here on.
      e.preventDefault();
      sendSpecialKey('Backspace');
      trimIosWord(1);
      fillIosBuf();
    } else if (inputType === 'insertLineBreak') {
      e.preventDefault();
      sendActionKey();
      iosWord = '';
      clearIosBuf();
    }
  }

  function onProxyInput(e) {
    if (!getRfb() || !proxy) return;
    e2e.noteInput();
    noteProxyInput();
    const currentValue = proxy.value;
    const inputType = e.inputType;
    noteImeEvent('input:' + (inputType || '-'));
    dbgv('input type=' + inputType + ' vlen=' + currentValue.length +
      ' comp=' + (isComposing || e.isComposing ? 1 : 0) + ' plat=' + (isAndroid ? 'a' : 'i'));

    if (isAndroid || mirrorOn()) {
      if (pendingBackspaceTimer !== null) { clearTimeout(pendingBackspaceTimer); pendingBackspaceTimer = null; }
      // The user is editing the seeded text now — a late-arriving remote value must
      // not clobber it (see applySignal). This is the authoritative "typing began".
      onMirrorSeedConsumed();

      // MIRROR: the proxy holds the FULL field text, so lastSentValue is the whole
      // field — NOT a word (the Android branches below reset per word and assume
      // that). A minimal common-prefix diff sends only the changed tail: a one-word
      // autocorrect becomes a couple of keystrokes, not a delete-and-retype of the
      // entire field. End-anchored, matching the caret-at-end seed model; it's
      // grapheme- and surrogate-safe and honors composition (see diffAndSend).
      if (mirrorOn()) {
        if (currentValue !== lastSentValue) diffAndSend(lastSentValue, currentValue);
        lastSentValue = currentValue;
        return;
      }

      // NOTE: do NOT suppress sends during composition on Android. SwiftKey,
      // Samsung Keyboard and Gboard run EVERY word through a composition session
      // (the predictive bar), so withholding marked-text steps drops normal
      // keystrokes and produces the "space re-types the previous word" bug. We
      // mirror each step via the value-diff below (the proven reference behavior).

      // An explicit delete inputType with NOTHING removed locally (the usual case:
      // an empty buffer) is the keystroke itself reaching us — one remote delete.
      // When the buffer DID shrink, fall through to the shrink handler below: one
      // press removes one grapheme, but a selection delete or a cut removes the
      // whole range in a SINGLE event and Gboard/SwiftKey report both as
      // deleteContentBackward. Sending a fixed single Backspace there left the rest
      // of the selection on the remote while lastSentValue claimed it was gone —
      // desyncing the field permanently, since every later diff built on it.
      if (inputType === 'deleteContentBackward' || inputType === 'deleteByCut' ||
          inputType === 'deleteContent' || inputType === 'deleteContentForward') {
        if (currentValue.length >= lastSentValue.length) {
          sendSpecialKey('Backspace');
          lastSentValue = currentValue;
          return;
        }
      }

      // Value shrunk → user deleted. Clean-suffix trim: backspace just the removed
      // tail (grapheme-aware so one emoji ZWJ sequence sends ONE Backspace, not
      // one-per-code-unit which would eat preceding chars) and leave the surviving
      // prefix on the remote. Non-suffix shrink (a mid-word autocorrect that both
      // shortened AND diverged, e.g. 'helllo'->'hello'): the surviving remote
      // prefix is wrong, so backspace ALL of lastSentValue and retype currentValue
      // — same delete-and-retype the grow/same-length autocorrect branches use.
      // (Backspacing only the length delta would leave a stub and duplicate: 'helll'
      // + 'hello' = 'helllhello'.)
      if (currentValue.length < lastSentValue.length) {
        const cleanSuffix = lastSentValue.startsWith(currentValue);
        const bs = cleanSuffix ? backspaceCountFor(lastSentValue.slice(currentValue.length))
                               : backspaceCountFor(lastSentValue);
        sendSpecialKey('Backspace', bs);
        if (currentValue && !cleanSuffix) sendText(currentValue);
        lastSentValue = currentValue;
        return;
      }

      // No inputType guard here. The two branches below already discriminate on the
      // only thing that matters — grew, or same length and different — and the
      // shrink case returned above. Gating on insertText/insertCompositionText
      // instead meant an EQUAL-LENGTH replacement under any other inputType fell
      // through to `lastSentValue = currentValue` and sent nothing at all: tapping
      // a Gboard suggestion or a Grammarly rewrite that swaps 'teh' for 'the'
      // arrives as insertReplacementText, so the correction never reached the
      // remote and the field silently kept the typo.
      {
        if (currentValue.length > lastSentValue.length) {
          if (currentValue.startsWith(lastSentValue)) {
            // Append-only: send just the new tail.
            const newChars = currentValue.slice(lastSentValue.length);
            const filtered = filterAutoSpace(newChars);
            if (filtered) sendText(filtered);
            // Don't reset value mid-composition — mutating it cancels the IME
            // (CJK). Auto-space stripping only diverges for Latin punctuation,
            // which isn't composing, so this guard is a safety net.
            if (filtered !== newChars && !isComposing) { proxy.value = ''; lastSentValue = ''; return; }
          } else if (isComposing) {
            // Composing jamo/tone/candidate churn: minimal common-prefix diff so a
            // one-syllable morph is 1 backspace + 1 char, not a full word rewrite.
            diffAndSend(lastSentValue, currentValue);
          } else {
            // Autocorrect mid-word: delete old (grapheme-aware), retype new.
            sendSpecialKey('Backspace', backspaceCountFor(lastSentValue));
            const filtered = filterAutoSpace(currentValue);
            if (filtered) sendText(filtered);
            if (filtered !== currentValue) { proxy.value = ''; lastSentValue = ''; return; }
          }
        } else if (currentValue !== lastSentValue && currentValue.length > 0) {
          if (isComposing) {
            diffAndSend(lastSentValue, currentValue); // minimal jamo/tone edit
          } else {
            // Same length, different content (whole-word autocorrect).
            sendSpecialKey('Backspace', backspaceCountFor(lastSentValue));
            const filtered = filterAutoSpace(currentValue);
            if (filtered) sendText(filtered);
            if (filtered !== currentValue) { proxy.value = ''; lastSentValue = ''; return; }
          }
        }
      }

      lastSentValue = currentValue;
      return;
    }

    // iOS hold-to-repeat backspace: a buffer delete just shrank the field. Count
    // the eaten zero-width chars, send that many remote Backspaces, then refill so
    // a held key keeps repeating. Torn down by the next insert (clearIosBuf).
    if (iosBuf && !isComposing && !eventComposing(e)) {
      const eaten = IOS_BUF_N - currentValue.length;
      if (eaten > 0) {
        sendSpecialKey('Backspace', eaten);
        trimIosWord(eaten);
        dbgv('iosBuf del eaten=' + eaten);
        fillIosBuf();
      } else if (currentValue.length > IOS_BUF_N) {
        clearIosBuf(); // text slipped past the buffer — bail to clean state
      }
      return;
    }

    // iOS / non-Android fallback (some Safari builds skip beforeinput).
    // While an IME is composing (Chinese Pinyin/Zhuyin, Japanese Kana/Romaji,
    // Korean Hangul), `input` fires for every intermediate marked-text change —
    // forwarding those would spew half-composed garbage and then duplicate the
    // word when compositionend commits it. Wait for compositionend to send the
    // final text exactly once.
    if (eventComposing(e)) return;
    if (currentValue) sendText(currentValue);
    proxy.value = '';
  }

  function onProxyKeyDown(e) {
    if (!getRfb() || !proxy) return;
    dbgv('keydown key=' + safeKeyName(e.key) + ' code=' + e.keyCode + ' comp=' + (e.isComposing ? 1 : 0));
    // Backspace with an EMPTY local buffer must always delete on the REMOTE, even
    // mid-"composition". Gboard keeps a glide-typed (swiped) word flagged as
    // composing, so its backspace arrives with isComposing/keyCode 229 — the guard
    // below would swallow it, making it impossible to delete a glided word or the
    // text before it. Nothing is composing locally (value is empty), so it can only
    // mean "delete on the remote".
    if (e.key === 'Backspace' && proxy.value === '') {
      e.preventDefault();
      sendSpecialKey('Backspace');
      // iOS: seed the chew buffer so a HELD backspace keeps repeating (see the
      // iOS beforeinput deleteContentBackward path). No-op on Android — and no-op
      // in mirror mode, where a populated field shrinks on delete so iOS
      // auto-repeats natively (the chew buffer would corrupt the value-diff).
      if (!isAndroid && !mirrorOn()) { trimIosWord(1); fillIosBuf(); }
      return;
    }
    // Gboard (glide) and Indic IMEs fire the DELETE key as 'Unidentified', flagged
    // composing and with the buffer often NON-empty — so it must be handled BEFORE
    // the composition guard, and NOT gated on an empty value. Defer a remote
    // backspace that a following beforeinput/input CANCELS (a real character), so a
    // keydown-only delete (glide) reaches the remote and a character doesn't get a
    // spurious backspace. Runs on SECRETS too: skipping it there ("never guess on a
    // secret") left the delete key dead on every password and OTP, so a typo was
    // uncorrectable and the login failed silently. Barely a guess anyway —
    // onProxyInput clears this timer before handling any real input event.
    if (e.key === 'Unidentified') {
      if (pendingBackspaceTimer !== null) clearTimeout(pendingBackspaceTimer);
      pendingBackspaceTimer = setTimeout(() => { pendingBackspaceTimer = null; sendSpecialKey('Backspace'); }, 90);
      return;
    }
    // During IME composition, Enter/Escape/Space commit or dismiss the candidate
    // window — they belong to the IME, not the remote page. keyCode 229 ("IME
    // busy") and e.isComposing both mark this; swallow the key so committing a
    // Pinyin/Kana candidate with Enter doesn't fire Enter at the remote form.
    if (e.isComposing || e.keyCode === 229) return;

    if (isAndroid) {
      // Android only, deliberately. On iOS clearProxy() tears down the chew
      // buffer that hold-to-repeat backspace depends on, and no iOS soft keyboard
      // ships arrows — only a hardware keyboard on iPad would reach this, which
      // is untested. Keep the blast radius to the paths that were verified.
      if (handleCaretKey(e)) return;
      switch (e.key) {
        case 'Backspace':
          if (proxy.value === '') { e.preventDefault(); sendSpecialKey('Backspace'); }
          return;
        case 'Enter':
          e.preventDefault(); sendActionKey(); proxy.value = ''; lastSentValue = ''; return;
        case 'Tab':
          e.preventDefault(); sendSpecialKey('Tab'); proxy.value = ''; lastSentValue = ''; return;
        case 'Escape':
          e.preventDefault(); toggleKeyboard(); return;
      }
      return;
    }

    // iOS mirror: the field is populated, so let iOS delete natively (the value
    // shrinks → onProxyInput value-diffs it into a remote Backspace, and a held
    // key repeats on its own). An empty field is already handled above. Enter/Tab
    // can't be expressed in the value, so forward them and re-sync the mirror.
    if (mirrorOn()) {
      switch (e.key) {
        case 'Backspace': return; // native delete → value-diff
        case 'Enter':     e.preventDefault(); sendActionKey(); proxy.value = ''; lastSentValue = ''; return;
        case 'Tab':       e.preventDefault(); sendSpecialKey('Tab');   proxy.value = ''; lastSentValue = ''; return;
        case 'Escape':    e.preventDefault(); toggleKeyboard();        return;
      }
      return;
    }

    // iOS / non-Android.
    switch (e.key) {
      case 'Backspace':
        if (iosBuf && proxy.value.length > 0) return; // held repeat: let iOS eat a buffer char
        e.preventDefault(); sendSpecialKey('Backspace'); trimIosWord(1); fillIosBuf(); return;
      case 'Enter':     e.preventDefault(); sendActionKey();            proxy.value = ''; return;
      case 'Tab':       e.preventDefault(); sendSpecialKey('Tab');       proxy.value = ''; return;
      case 'Escape':    e.preventDefault(); toggleKeyboard();            return;
    }
  }

  function onProxyBlur() {
    // Any pending composition dies with the field losing focus. Clear the flags
    // unconditionally so a blur mid-word (tap away, back button, swipe-down) can't
    // leave isComposing/ecSuppressed latched and wedge the NEXT field's first
    // edit into the composing/commit-only branch.
    isComposing = false; echo.setComposing(''); ecSuppressed = false;
    ecCommittedWord = false; ecComposeReconciled = false;
    // System back-button / swipe-down dismiss blurs the proxy without our own
    // flow (which sets allowBlur first) — the keyboard-state side lives in the
    // core (onSystemBlur decides via keyboardActive/allowBlur and tears down).
    onSystemBlur();
  }

  function onCompositionStart() {
    isComposing = true;
    composedForwarded = false; // fresh composition — nothing forwarded yet
    ecComposeReconciled = false; // re-arm the EC re-grab check for this word
    // A seeded delete-buffer must not pollute an IME composition (the marked
    // text would land after the joiners). Tear it down so composition starts on
    // a clean empty field. No-op on Android / when no buffer is up.
    if (!isAndroid && iosBuf) clearIosBuf();
    dbg('composition start');
  }

  function onCompositionEnd(e) {
    e2e.noteInput();
    isComposing = false;
    dbg('composition end len=' + (e && e.data ? e.data.length : 0));
    echo.setComposing(''); echo.render(); // committed; sendText below appends it
    if (isAndroid) {
      // Commit-only mode withheld the whole composition; flush the committed
      // delta now (minimal diff vs the last SENT value), then re-sync.
      if (composedSuppressed) {
        composedSuppressed = false;
        const cur = proxy ? proxy.value : '';
        if (cur !== lastSentValue) diffAndSend(lastSentValue, cur);
        lastSentValue = cur;
      }
      return; // otherwise handled by value-comparison in onProxyInput
    }
    // iOS/CJK: commit the final composed text once. Some WebKit builds, several
    // 3rd-party iOS keyboards, and Japanese/Korean reconversion fire
    // compositionend with an EMPTY .data even though the field holds the committed
    // word — the old `if (e.data)` dropped the whole word silently (looks exactly
    // like packet loss on 3G). Fall back to the proxy value in that case, unless a
    // composition step already forwarded the text (composedForwarded) so we don't
    // double-send. trackIosWord keeps the iOS autocorrect backspace-count aligned.
    if (e.data) { sendText(e.data); trackIosWord(e.data); }
    else if (!composedForwarded && !mirrorOn() && proxy && proxy.value) {
      // Empty .data but the field holds the committed word: recover it. Scoped to
      // the non-mirror iOS path where proxy.value is JUST the composed delta —
      // in mirror mode proxy.value is the whole field and the value-diff in
      // onProxyInput already sent the delta, so sending it here would duplicate it.
      sendText(proxy.value); trackIosWord(proxy.value);
    }
    composedForwarded = false;
    if (proxy) proxy.value = '';
  }


  // The standards-based replacement for the value-diff hack: the EditContext
  // owns an editing buffer decoupled from the DOM. `textupdate` reports every
  // buffer change (typing, autocorrect, and each composition step) as a range
  // replacement; we translate that to remote keystrokes and keep the buffer
  // empty between commits so deltas stay small and the caret stays at the end.

  function resetEC() {
    if (!editCtx) return;
    try {
      editCtx.updateText(0, editCtx.text.length, '');
      editCtx.updateSelection(0, 0);
    } catch (_) {}
    ecText = '';
    lastSentValue = '';
  }

  function clearProxy() {
    ecCommittedWord = false; ecComposeReconciled = false; // new field / dismiss: fresh
    if (ecMode) { resetEC(); return; }
    iosBuf = false;
    if (proxy && 'value' in proxy) proxy.value = '';
    lastSentValue = '';
  }

  // Mirror mode is active for THIS field when: the flag is set, we're on the iOS
  // <input> path (Android already value-diffs via EditContext; desktop is out of
  // scope), and the field is non-sensitive (secret fields never publish val, so
  // remoteValue would be stale/empty and must never be seeded anyway).
  function mirrorOn() {
    return MIRROR && isIOS && !ecMode && !getSensitiveField() &&
      proxy && proxy.tagName === 'INPUT';
  }

  // Populate the proxy with the remote field's real text and park the caret at
  // the end (the extension collapses the tap select-all to a caret at end, so
  // end-anchored append/backspace diffs stay aligned with the remote caret).
  // Programmatic value assignment does NOT fire `input`, so this can't trip a
  // spurious value-diff; we set lastSentValue to match so the first real edit
  // diffs from the seeded text.
  function seedProxyMirror() {
    if (!mirrorOn()) return false;
    const v = getRemoteValue() || '';
    iosBuf = false;
    try {
      proxy.value = v;
      proxy.setSelectionRange(v.length, v.length);
    } catch (_) {}
    lastSentValue = v;
    dbg('mirror seed len=' + v.length);
    return true;
  }

  function onECTextUpdate(e) {
    if (!editCtx) return; // rfb-null is fine: sendText/sendSpecialKey queue it
    e2e.noteInput();
    noteProxyInput();
    noteImeEvent('editcontext:textupdate');
    dbgv('EC textupdate tlen=' + (e.text ? e.text.length : 0) + ' del=' +
      (e.updateRangeEnd - e.updateRangeStart) + ' comp=' + (isComposing ? 1 : 0) +
      ' suppress=' + (ecSuppressed ? 1 : 0));

    const rangeStart = Math.max(0, e.updateRangeStart || 0);
    const rangeEnd = Math.max(rangeStart, e.updateRangeEnd || rangeStart);
    const deletedUnits = rangeEnd - rangeStart;
    // `editCtx.text` has already changed by the time this event is delivered;
    // the removed text exists only in our previous shadow buffer.
    const deletedText = ecText.slice(rangeStart, rangeEnd);
    // A browser can deliver the first update after an IME restored its own
    // buffer, before we have observed that buffer. Preserve the old raw-range
    // fallback for that one unobservable case; once shadow text is available,
    // use its grapheme-aware count.
    const deleted = deletedText ? backspaceCountFor(deletedText) : deletedUnits;

    // A deferred backspace (onECKeyDown fired on Unidentified/Backspace, unsure if
    // it was a delete or a character) is CANCELLED by a following textupdate that
    // carries a real character (text) or a real deletion (del>0) — proof it wasn't a
    // plain delete. But an EMPTY, non-composing update (no text, del=0) is the
    // OPPOSITE: after an autocorrect, SwiftKey's buffer holds the corrected word
    // while ours is empty, so ITS backspaces arrive as Unidentified + an empty
    // textupdate. Those must NOT cancel the deferred backspace — otherwise the first
    // few presses delete SwiftKey's phantom word and never reach the remote (you had
    // to press backspace several times before it took). Let the deferred one fire.
    const phantomDelete = !isComposing && (!e.text || e.text.length === 0) && deletedUnits === 0;
    if (pendingBackspaceTimer !== null && !phantomDelete) { clearTimeout(pendingBackspaceTimer); pendingBackspaceTimer = null; }

    // Re-grab: SwiftKey/Samsung commit each key as ordinary text (comp=0), then
    // RE-COMPOSE the whole word on space to autocorrect it / accept the top
    // suggestion ("Tes"+space -> "Tea"), or when you tap a candidate. Because we keep
    // the EC buffer empty between commits, that re-grab arrives as an INSERT (del=0)
    // of the word already on the remote — so applying it as-is would DUPLICATE it
    // ("test"+space -> "testtest"). On the first composing update — whole word at
    // once (e.text === buffer), nothing replaced (del=0), a word just committed
    // non-composing — delete that word so the composition REPLACES it. This applies
    // the keyboard's autocorrect/pick natively (mirrors what a real field does) and,
    // because the remote now matches the keyboard's buffer, backspace stays in sync.
    // editCtx.text length is authoritative. Gboard/CJK compose from an EMPTY buffer
    // (ecCommittedWord=false), so real composition / glide / CJK never triggers this.
    if (isComposing && !ecComposeReconciled && editCtx.text) {
      ecComposeReconciled = true;
      if (deleted === 0 && ecCommittedWord && e.text === editCtx.text) {
        dbg('EC re-compose reconcile len=' + editCtx.text.length);
        sendSpecialKey('Backspace', backspaceCountFor(editCtx.text));
        ecCommittedWord = false;
      }
    }

    // Slow-link commit-only: while composing, don't mirror each marked-text step;
    // preview the buffer locally and send the whole committed text once at
    // compositionend (the buffer resets per commit, so it starts empty and the
    // remote gets nothing until then). Sticky for the composition once engaged.
    if (isComposing && (ecSuppressed || commitOnly())) {
      ecSuppressed = true;
      if (echo.allowed()) { echo.setComposing(stripCtl(editCtx.text)); echo.render(); }
      ecText = editCtx.text;
      return; // no send, no reset — editCtx.text accumulates the full composition
    }

    if (deleted > 0) sendSpecialKey('Backspace', deleted);
    if (e.text) {
      // Mid-composition, forward the composing text as-is (mirrors Android
      // incremental composition on the remote). Only strip SwiftKey auto-space
      // for committed text.
      const out = isComposing ? e.text : filterAutoSpace(e.text);
      if (out) {
        sendText(out);
        // Mark whether an unfinished word is now committed non-composing, so a
        // following re-compose (above) knows to replace it. True unless the last
        // committed char was a word boundary.
        if (!isComposing) {
          for (const ch of out) {
            ecCommittedWord = !(ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t');
          }
        }
      }
    }
    // Local preview of the unconfirmed composing buffer (read before any reset).
    if (isComposing) echo.setComposing(stripCtl(editCtx.text)); else echo.setComposing('');
    echo.render();
    // Keep the buffer empty when not composing so the next delta is fresh and
    // an empty-buffer Backspace surfaces via keydown. Never reset during
    // composition — mutating the buffer cancels the IME.
    if (!isComposing) resetEC();
    else ecText = editCtx.text;
  }

  function onECCompositionEnd() {
    e2e.noteInput();
    // Commit-only mode withheld every step; send the accumulated committed text
    // once (read the buffer BEFORE resetEC clears it).
    if (ecSuppressed) {
      ecSuppressed = false;
      const committed = editCtx ? editCtx.text : '';
      if (committed) { const f = filterAutoSpace(committed); if (f) sendText(f); }
    }
    // The final composed text already went out via the last textupdate; just
    // clear the buffer for the next word.
    isComposing = false;
    echo.setComposing(''); echo.render();
    ecCommittedWord = false; ecComposeReconciled = false; // fresh state for the next word
    resetEC();
  }

  function onECKeyDown(e) {
    if (!getRfb()) return;
    e2e.noteInput();
    dbgv('EC keydown key=' + safeKeyName(e.key) + ' code=' + e.keyCode + ' comp=' + (e.isComposing ? 1 : 0));
    const empty = !editCtx || editCtx.text === '';
    // Delete keys are handled BEFORE the composition guard. Gboard leaves a
    // glide-typed (swiped) word flagged composing and fires its DELETE as
    // keydown 'Unidentified' (like Indic IMEs) — with the buffer NON-empty — so
    // the old empty-only Unidentified handling (and the guard below) missed it,
    // making glided words undeletable.
    if (e.key === 'Backspace' && empty) {
      // Nothing composing locally → delete on the REMOTE now.
      e.preventDefault(); sendSpecialKey('Backspace'); return;
    }
    if (e.key === 'Backspace' || e.key === 'Unidentified') {
      // Backspace on a non-empty buffer, OR an ambiguous 'Unidentified' key
      // (could be a glide/Indic delete OR a character): defer a remote backspace
      // that a following textupdate CANCELS (a real character always produces one;
      // onECTextUpdate clears this timer up top even when it suppresses the send).
      // So a keydown-only delete (glide) reaches the remote, and a character does
      // not get a spurious backspace. Runs on SECRETS too — see onProxyKeyDown.
      // Gboard glide, Indic, SwiftKey and Samsung all report delete this way, so
      // the old exemption left it dead on every password and OTP field.
      if (pendingBackspaceTimer !== null) clearTimeout(pendingBackspaceTimer);
      pendingBackspaceTimer = setTimeout(() => { pendingBackspaceTimer = null; sendSpecialKey('Backspace'); }, 90);
      return;
    }
    // Composition owns Enter/Escape/Space (commit/dismiss candidate) — don't
    // forward them to the remote. keyCode 229 / e.isComposing mark IME activity.
    if (e.isComposing || e.keyCode === 229) return;
    if (handleCaretKey(e)) return;
    switch (e.key) {
      case 'Enter': e.preventDefault(); sendActionKey(); resetEC(); return;
      case 'Tab': e.preventDefault(); sendSpecialKey('Tab'); resetEC(); return;
      case 'Escape': e.preventDefault(); toggleKeyboard(); return;
    }
  }


  return {
    // handlers (attached by setup / EC wiring)
    onProxyBeforeInput, onProxyInput, onProxyKeyDown, onProxyBlur,
    onCompositionStart, onCompositionEnd,
    onECTextUpdate, onECCompositionEnd, onECKeyDown,
    eventComposing,

    // state verbs
    clearProxy, seedProxyMirror, mirrorOn,
    // A raise/dismiss is a fresh field — clear any composition flags a prior
    // field's abandoned composition left latched (just the flags, not the EC
    // buffer). Replaces the repeated 4-flag reset lines in the core.
    resetComposition() {
      isComposing = false; echo.setComposing(''); ecSuppressed = false; composedForwarded = false;
    },
    // applySignal's mirror idle-reconcile: the remote field is the source of
    // truth — adopt its value into the proxy and re-baseline the diff.
    adoptRemoteValue(val) {
      dbg('mirror idle reconcile ' + lastSentValue.length + '->' + val.length);
      try { proxy.value = val; proxy.setSelectionRange(val.length, val.length); } catch (_) {}
      lastSentValue = val;
    },

    // wiring from setup()
    setProxy(p) { proxy = p; },
    setEcMode(v) { ecMode = v; },
    setEditContext(ec) { editCtx = ec; },

    // getters for the few outside readers
    composing: () => isComposing,
    lastInputAt: () => lastProxyInputAt,
    lastSentValue: () => lastSentValue,
    ecMode: () => ecMode,
  };
}
