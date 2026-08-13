// ime-hints.js — shape the proxy so platform keyboards pick the right layout.
//
// Pure function of (proxy, remote-field hints, mirror-mode flag): derives
// inputmode / autocomplete / enterkeyhint / autocapitalize / autocorrect /
// spellcheck from what the extension reports about the focused remote field, so
// Gboard/Samsung/SwiftKey/iOS show the same keypad and behaviors a real phone
// would on that field. No state; the core calls it via a 1-line wrapper that
// supplies its currentHints and mirrorOn().

// Whether the CURRENTLY focused remote field takes literal input (email/url/tel/
// number/password/search). Read by the send path: a space is invalid in an email
// address and must be encoded in a URL, so one must never reach such a field —
// see the literalField derivation below for why we can't just read proxy.type.
let currentFieldIsLiteral = false;
export function fieldIsLiteral() { return currentFieldIsLiteral; }

// Whether a SPACE is invalid in the focused field, which is NARROWER than
// literalField: that set includes password, and passphrases legitimately contain
// spaces — filtering them would silently break logins instead of fixing them. Only
// address-like fields qualify (an email address cannot contain an unquoted space; a
// URL must percent-encode one; usernames on such forms don't take them either).
let currentFieldRejectsSpace = false;
export function fieldRejectsSpace() { return currentFieldRejectsSpace; }

// Returns a summary of what the remote reported and what we derived, for the CALLER
// to log — every keyboard question so far (leading capitals, the Gboard trailing
// space) came down to this value, and guessing at it cost several wrong fixes.
// Returned rather than logged here so this module stays import-free and unit-testable.
export function applyImeHints(proxy, hints, { mirrorOn }) {
  if (!proxy) return null;
  const info = hints || {};
  const remoteType = (info.type || '').toLowerCase();
  const remoteInputMode = (info.inputMode || '').toLowerCase();
  const remoteAC = info.autoComplete || '';
  const remoteEKH = (info.enterKeyHint || '').toLowerCase();
  const remoteTag = (info.tag || '').toUpperCase();
  const isTextArea = remoteTag === 'TEXTAREA';
  const remotePattern = info.pattern || '';
  const remoteName = (info.name || '').toLowerCase();
  const remotePlaceholder = (info.placeholder || '').toLowerCase();

  // type only applies to the <input> fallback; the EditContext div takes its
  // layout hint from the inputmode attribute below.
  if (proxy.tagName === 'INPUT') {
    // Keep the proxy type=text ALWAYS and drive the on-screen keypad purely via
    // the inputmode attribute below. Mirroring the remote type onto the proxy
    // broke two paths: type=number sanitizes the seeded value (mirror seed +
    // chew buffer) and BOTH type=number and type=email make setSelectionRange
    // throw ("does not support selection"), which the fillIosBuf chew buffer and
    // seedProxyMirror rely on. inputmode gives the same keypad without those
    // side effects. (type=password was never mirrored either — it forces the iOS
    // Passwords AutoFill accessory, which steals proxy focus and breaks the lift.)
    try { proxy.type = 'text'; } catch (_) {}
  }

  // Most sites use <input type=number|tel|email|url|search> WITHOUT an
  // inputmode attribute, so on the EditContext path (mainstream Android) those
  // fields would get the full text keyboard instead of the right pad. Derive
  // inputmode from the field type when the remote didn't specify one — gives
  // numeric/tel/email/url pads across Gboard, Samsung, Oppo/ColorOS, etc.
  // number -> 'decimal' (not 'numeric'): 'numeric' is a digits-only pad with no
  // decimal separator, so price/amount/quantity fields can't type "1.50".
  // 'decimal' adds the separator key and still shows a numeric pad.
  // Last-resort numeric pad for the legacy pattern="[0-9]*" / pattern="\d{6}"
  // OTP/PIN/zip idiom (widespread, predates inputmode) when neither an explicit
  // inputmode nor a numeric field type applies. STRICT digits-only: after stripping
  // anchors, only [0-9]/\d with an optional *, +, {n}, {n,}, {n,m} quantifier —
  // anything with a separator, alternation, or letter class is rejected (a decimal
  // or formatted pattern must NOT get the separator-less numeric pad).
  const numericFromPattern = (pat) => {
    if (!pat) return '';
    const core = pat.replace(/^\^/, '').replace(/\$$/, '');
    return /^(\[0-9\]|\\d)([*+]|\{\d+(,\d*)?\})?$/.test(core) ? 'numeric' : '';
  };
  const derivedInputMode = remoteInputMode ||
    ({ number: 'decimal', tel: 'tel', email: 'email', url: 'url', search: 'search' }[remoteType] || '') ||
    numericFromPattern(remotePattern);
  if (derivedInputMode) { try { proxy.setAttribute('inputmode', derivedInputMode); } catch (_) {} }
  else { try { proxy.removeAttribute('inputmode'); } catch (_) {} }

  // Adopt the remote field's script direction + language so RTL fields (Arabic,
  // Hebrew) render right-to-left and the OS IME loads the right dictionary. Only
  // the three valid dir values pass; anything else clears it.
  const remoteLang = info.lang || '';
  try { if (remoteLang) proxy.setAttribute('lang', remoteLang); else proxy.removeAttribute('lang'); } catch (_) {}
  const remoteDir = (info.dir || '').toLowerCase();
  const dir = (remoteDir === 'rtl' || remoteDir === 'ltr' || remoteDir === 'auto') ? remoteDir : '';
  try { if (dir) proxy.setAttribute('dir', dir); else proxy.removeAttribute('dir'); } catch (_) {}

  // Force autocomplete off so iOS/Android never offer the stored-credential
  // AutoFill bar (the "localhost" bubble), which steals proxy focus and breaks
  // the keyboard lift. Keep only one-time-code (SMS autofill, not a credential).
  const acLower = (remoteAC || '').toLowerCase();
  const safeAC = acLower === 'one-time-code' ? 'one-time-code' : 'off';
  try { proxy.setAttribute('autocomplete', safeAC); } catch (_) {}

  // Derive a sensible Return-key glyph from the field type when the remote
  // didn't set enterkeyhint: search fields read "Search", url/email read "Go".
  const derivedEKH = remoteEKH ||
    ({ search: 'search', url: 'go', email: 'go' }[remoteType] || '');
  if (derivedEKH) { try { proxy.setAttribute('enterkeyhint', derivedEKH); } catch (_) {} }
  else { try { proxy.removeAttribute('enterkeyhint'); } catch (_) {} }

  // Mirror capitalization / correction so the proxy keyboard behaves like the
  // remote field would on a real phone. Fields that expect literal input
  // (email/url/tel/number/password/search) force these OFF exactly as browsers
  // do; text/textarea default to the platform default (sentences + correct)
  // unless the remote opted out. Local echo shows the corrected/capitalized
  // text, so this is safe to enable rather than hardcoding everything off.
  // Not keyed on `type` alone: plenty of sign-in pages ship
  // <input type="text" name="email" autocomplete="username">, which is prose as far
  // as `type` is concerned. Gboard then treats it as prose too — auto-capitalising
  // the first letter and, when you tap a suggestion, committing the word PLUS a
  // trailing space. That space is invisible in the field and makes the site reject a
  // perfectly good address ("incorrect email or password"). inputmode and
  // autocomplete are the same signals real autofill uses.
  const acIsLiteral = /^(email|username|url)$/.test((info.autoComplete || '').toLowerCase());
  const imIsLiteral = remoteInputMode === 'email' || remoteInputMode === 'url';
  // Last resort: the field's NAME. Kaggle's sign-in is
  // <input type="text" autocomplete="on" name="email"> — type says nothing,
  // autocomplete="on" says nothing, and name is the only attribute that identifies
  // it. This is the same signal browser autofill falls back on. Restricted to
  // <input> so a textarea named "user_message" (or one whose placeholder says "email
  // us") can't be mistaken for an address box, and matched on whole words so
  // "email_opt_in" style checkbox names don't drag prose fields in.
  const nameIsAddress = !isTextArea &&
    /(^|[^a-z])(e-?mail|user|username|userid|login)([^a-z]|$)/.test(remoteName);
  const phIsAddress = !isTextArea && /e-?mail address|email or username/.test(remotePlaceholder);
  const literalField = remoteType === 'email' || remoteType === 'url' ||
    remoteType === 'tel' || remoteType === 'number' ||
    remoteType === 'password' || remoteType === 'search' ||
    acIsLiteral || imIsLiteral || nameIsAddress || phIsAddress;
  // Log what the extension ACTUALLY reported plus what we derived. Every keyboard
  // question so far (leading capitals, the Gboard trailing space) has come down to
  // this, and guessing at it has cost several wrong fixes.
  currentFieldIsLiteral = literalField;
  currentFieldRejectsSpace = remoteType === 'email' || remoteType === 'url' ||
    acIsLiteral || imIsLiteral || nameIsAddress || phIsAddress;
  const remoteCap = (info.autoCapitalize || '').toLowerCase();
  const remoteCorrect = (info.autoCorrect || '').toLowerCase();
  const remoteSpell = (info.spellCheck || '').toLowerCase();

  // A one-time-code field (often type=text so it's not "literal") must not
  // auto-capitalize — codes are case-exact, and 'none' is what lets iOS show the
  // SMS-code QuickType chip above the keyboard on a type=text OTP input.
  const isOTP = safeAC === 'one-time-code';
  let cap;
  if (remoteCap) cap = remoteCap;                    // remote was explicit
  else if (literalField || isOTP) cap = 'none';      // browsers force this off
  // Prose only. A browser DOES sentence-capitalize a bare <input type=text> on a
  // phone, but the pages we drive are overwhelmingly desktop sites that never
  // considered a soft keyboard, and their single-line inputs are usernames, IDs,
  // account numbers, codes and search boxes — where a capitalized first letter is
  // simply wrong (observed on a real login: typing "test" produced "Test"). A
  // <textarea> is the one field type that reliably means prose, so it keeps the
  // platform default. A site that genuinely wants caps in an input still gets them
  // via the explicit branch above, since remoteCap wins.
  else cap = isTextArea ? 'sentences' : 'none';
  try { proxy.setAttribute('autocapitalize', cap); } catch (_) {}

  // autocorrect is Safari/iOS; spellcheck is cross-engine. Off for literal
  // fields and whenever the remote said off; else on for prose fields.
  let wantCorrect = remoteCorrect ? remoteCorrect !== 'off'
    : (!literalField && (isTextArea || remoteType === 'text' || remoteTag === '' || proxy.isContentEditable));
  // Force autocorrect (and spellcheck-driven correction) OFF on ALL mobile paths
  // — iOS <input> AND Android EditContext. The keyboard's auto-accept-on-space
  // silently REPLACES the typed word (SwiftKey "Tes" -> "Tea") and then a
  // backspace-to-revert fires a confusing re-composition. Corrections should only
  // apply when the user explicitly TAPS a suggestion, which still works with
  // autocorrect off (the prediction bar and glide typing are not gated by it).
  // On iOS the tapped-suggestion pick was ALSO unrecoverable (eventless write
  // into the empty proxy), which is a second reason it's off there.
  // Mirror mode keeps it ON: the proxy holds the real field text, so a tapped
  // suggestion fires a normal insertReplacementText that diffs cleanly.
  if (!mirrorOn()) wantCorrect = false;
  try { proxy.setAttribute('autocorrect', wantCorrect ? 'on' : 'off'); } catch (_) {}
  const wantSpell = !mirrorOn() ? false
    : (remoteSpell ? remoteSpell !== 'false' : wantCorrect);
  try { proxy.setAttribute('spellcheck', wantSpell ? 'true' : 'false'); } catch (_) {}

  return {
    tag: remoteTag || '-', type: remoteType || '-', im: remoteInputMode || '-',
    ac: remoteAC || '-', pat: remotePattern ? 1 : 0,
    name: remoteName || '-', nm: nameIsAddress ? 1 : 0, ph: phIsAddress ? 1 : 0,
    literal: literalField ? 1 : 0, nospace: currentFieldRejectsSpace ? 1 : 0,
    cap, correct: wantCorrect ? 1 : 0,
  };
}
