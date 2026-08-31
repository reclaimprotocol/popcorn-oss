// field-hints.test.mjs — characterization: applyImeHints.
// applyImeHints is a pure function of (proxy, remote hints, {mirrorOn}); these
// unit-test the pattern->numeric derivation, lang/dir propagation, and the OTP
// autocapitalize exemption directly against a minimal fake proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyImeHints, secureSurfaceWanted, fieldRejectsSpace } from '../ime-hints.js';

function fakeProxy(tagName = 'INPUT') {
  const attrs = {};
  return {
    tagName, type: 'text', isContentEditable: false,
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
  };
}
const NO_MIRROR = { mirrorOn: () => false };

test('legacy pattern="[0-9]*" on a type=text field derives a numeric pad', () => {
  const p = fakeProxy();
  applyImeHints(p, { type: 'text', tag: 'INPUT', pattern: '[0-9]*' }, NO_MIRROR);
  assert.equal(p.getAttribute('inputmode'), 'numeric');
});

test('anchored pattern="^\\d{6}$" derives numeric', () => {
  const p = fakeProxy();
  applyImeHints(p, { type: 'text', tag: 'INPUT', pattern: '^\\d{6}$' }, NO_MIRROR);
  assert.equal(p.getAttribute('inputmode'), 'numeric');
});

test('a decimal/formatted pattern does NOT get the separator-less numeric pad', () => {
  const p = fakeProxy();
  applyImeHints(p, { type: 'text', tag: 'INPUT', pattern: '[0-9]+([.,][0-9]+)?' }, NO_MIRROR);
  assert.equal(p.getAttribute('inputmode'), null);
});

test('explicit inputmode / numeric type win over the pattern fallback', () => {
  const p = fakeProxy();
  applyImeHints(p, { type: 'number', tag: 'INPUT', pattern: '[0-9]*' }, NO_MIRROR);
  assert.equal(p.getAttribute('inputmode'), 'decimal'); // type=number -> decimal (has separator), not numeric
});

test('lang and dir propagate to the proxy; an invalid dir is ignored', () => {
  const p = fakeProxy();
  applyImeHints(p, { type: 'text', tag: 'INPUT', lang: 'ar', dir: 'rtl' }, NO_MIRROR);
  assert.equal(p.getAttribute('lang'), 'ar');
  assert.equal(p.getAttribute('dir'), 'rtl');
  const p2 = fakeProxy();
  applyImeHints(p2, { type: 'text', tag: 'INPUT', dir: 'sideways' }, NO_MIRROR);
  assert.equal(p2.getAttribute('dir'), null);
});

test('one-time-code field: autocapitalize=none, autocomplete preserved for SMS chip', () => {
  const p = fakeProxy();
  applyImeHints(p, { type: 'text', tag: 'INPUT', autoComplete: 'one-time-code' }, NO_MIRROR);
  assert.equal(p.getAttribute('autocomplete'), 'one-time-code');
  assert.equal(p.getAttribute('autocapitalize'), 'none');
});

// --- autocapitalize: prose only -------------------------------------------------
// A plain <input type=text> on a desktop site is a username / ID / code far more
// often than a sentence, and capitalizing its first letter silently corrupts what
// the user typed ("test" -> "Test" on a real login form).

test('a bare <input type=text> does NOT auto-capitalize', () => {
  const p = fakeProxy('INPUT');
  applyImeHints(p, { type: 'text', tag: 'INPUT' }, NO_MIRROR);
  assert.equal(p.getAttribute('autocapitalize'), 'none');
});

test('a <textarea> keeps the platform sentence-caps default', () => {
  const p = fakeProxy('TEXTAREA');
  // The extension reports type:'text' for a textarea, so the TAG is what
  // distinguishes prose from a single-line field.
  applyImeHints(p, { type: 'text', tag: 'TEXTAREA' }, NO_MIRROR);
  assert.equal(p.getAttribute('autocapitalize'), 'sentences');
});

test('an explicit remote autocapitalize wins over the input default', () => {
  const p = fakeProxy('INPUT');
  applyImeHints(p, { type: 'text', tag: 'INPUT', autoCapitalize: 'words' }, NO_MIRROR);
  assert.equal(p.getAttribute('autocapitalize'), 'words');
});

test('an unknown tag is treated as a single-line field, not prose', () => {
  const p = fakeProxy('INPUT');
  applyImeHints(p, { type: 'text' }, NO_MIRROR);
  assert.equal(p.getAttribute('autocapitalize'), 'none');
});

test('literal fields stay none regardless of tag', () => {
  for (const type of ['email', 'url', 'tel', 'number', 'password', 'search']) {
    const p = fakeProxy('INPUT');
    applyImeHints(p, { type, tag: 'INPUT' }, NO_MIRROR);
    assert.equal(p.getAttribute('autocapitalize'), 'none', `${type} must not capitalize`);
  }
});

// ---- Kaggle's "EMAIL / USERNAME" field --------------------------------------
// A field that accepts either an address or a username ships as type=text with
// autocomplete=username, so `type` alone can never classify it. Gboard then treats
// it as prose: it capitalises the first letter AND, when you tap a suggestion,
// commits the word plus a trailing space. The space is invisible in the field and
// the site rejects a perfectly good address ("incorrect email or password") —
// one backspace makes the same login succeed.
test('type=text + autocomplete=username is treated as an address field', () => {
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'text', autoComplete: 'username' }, NO_MIRROR);
  assert.equal(p.getAttribute('autocapitalize'), 'none', 'no leading capital on an address');
  assert.equal(fieldRejectsSpace(), true, 'and a space must never reach it');
});

test('inputmode=email classifies too, even with a bare type', () => {
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'text', inputMode: 'email' }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), true);
});

test('a password field still accepts spaces — passphrases are legal', () => {
  // The wider `literalField` set includes password; the space filter must NOT.
  // Stripping spaces from a passphrase would silently break working logins.
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'password' }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), false);
});

test('an ordinary prose field is unaffected', () => {
  const p = fakeProxy();
  applyImeHints(p, { tag: 'TEXTAREA' }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), false);
});

// ---- name= as the last-resort signal ----------------------------------------
// Kaggle's sign-in is the motivating case, captured verbatim from the DOM:
//   <input type="text" autocomplete="on" name="email" placeholder="Enter your email
//    address or username">
// `type` says nothing, `autocomplete="on"` says nothing. `name` is the only
// attribute that identifies the field, which is why the extension now forwards it.
test('Kaggle sign-in: name=email classifies where type and autocomplete cannot', () => {
  const p = fakeProxy();
  applyImeHints(p, {
    tag: 'INPUT', type: 'text', autoComplete: 'on', name: 'email',
    placeholder: 'Enter your email address or username',
  }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), true, 'a Gboard suggestion space must not reach it');
});

test('a textarea is never treated as an address field, whatever it is called', () => {
  // Guards the obvious false positive: prose fields named user_message / "email us".
  const p = fakeProxy();
  applyImeHints(p, { tag: 'TEXTAREA', name: 'user_message', placeholder: 'Email address here' }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), false);
});

test('name matching is whole-word, so email_opt_in style names do not drag fields in', () => {
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'text', name: 'emailer_headline' }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), false);
});

test('name=password does not become space-rejecting', () => {
  // The word-boundary rule must not let "password" match via "user"/"login", and a
  // passphrase with spaces has to keep working.
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'password', name: 'password', autoComplete: 'current-password' }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), false);
});

// ---- the secure proxy type ---------------------------------------------------
// A credential field has to reach the IME as a real type=password <input>, or
// Android runs its prose pipeline on the secret: suggestion strip, word+SPACE on
// a suggestion tap, double-space to ". ". The send path cannot clean that up
// afterwards — it refuses to touch whitespace in a secret on purpose.

test('a sensitive field makes the proxy a password input', () => {
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'password', autoComplete: 'current-password' },
    { mirrorOn: () => false, secure: true });
  assert.equal(p.type, 'password');
});

test('the proxy goes back to text when the next field is not sensitive', () => {
  // Leaving a password on the same proxy must not strand it in password mode:
  // that would cost every later prose field its suggestions and glide typing.
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'password' }, { mirrorOn: () => false, secure: true });
  applyImeHints(p, { tag: 'INPUT', type: 'text' }, { mirrorOn: () => false, secure: false });
  assert.equal(p.type, 'text');
});

test('secure is the caller decision, so a password field alone does not flip the type', () => {
  // iOS passes secure:false for every field — type=password there summons the
  // Passwords AutoFill accessory, which steals proxy focus and breaks the lift.
  const p = fakeProxy();
  applyImeHints(p, { tag: 'INPUT', type: 'password', autoComplete: 'current-password' }, NO_MIRROR);
  assert.equal(p.type, 'text');
});

// ---- which fields want the password surface ----------------------------------
// Narrower than "sensitive" on purpose: password mode helps only where the IME
// would otherwise run a prose pipeline. Applying it to an OTP or a card number
// costs the numeric pad (Chrome gives type=password the TEXT keyboard whatever
// inputmode says) and, for one-time-code, the OS SMS chip too.

test('a password field wants the secure surface', () => {
  assert.equal(secureSurfaceWanted({ tag: 'INPUT', type: 'password' }, true), true);
});

test('a one-time-code field does not — it would lose the SMS chip', () => {
  assert.equal(secureSurfaceWanted(
    { tag: 'INPUT', type: 'text', autoComplete: 'one-time-code' }, true), false);
});

test('numeric keypads do not: no suggestions to suppress, and a pad to lose', () => {
  // CVV via the legacy pattern idiom, a tel field, and an explicit numeric
  // inputmode all reach the IME as a number pad, where no auto-space, no
  // suggestion strip and no double-space-to-period exist in the first place.
  assert.equal(secureSurfaceWanted({ tag: 'INPUT', type: 'text', pattern: '[0-9]*' }, true), false);
  assert.equal(secureSurfaceWanted({ tag: 'INPUT', type: 'tel' }, true), false);
  assert.equal(secureSurfaceWanted({ tag: 'INPUT', type: 'text', inputMode: 'numeric' }, true), false);
  assert.equal(secureSurfaceWanted({ tag: 'INPUT', type: 'number' }, true), false);
});

test('a non-sensitive field never wants it', () => {
  assert.equal(secureSurfaceWanted({ tag: 'INPUT', type: 'text' }, false), false);
  assert.equal(secureSurfaceWanted({ tag: 'TEXTAREA' }, false), false);
});

// ---- a secret is never an address field --------------------------------------
// nameIsAddress matches "user" as a whole word, so Rails' name="user[password]"
// (and user_password, login_password) reads as address-like — and an address-like
// field has EVERY space dropped in transport.js. On a masked field that is
// invisible: secrets publish no val/len, so nothing downstream can notice.

test('a Rails-style password name does not make the field space-rejecting', () => {
  const p = fakeProxy();
  applyImeHints(p, {
    tag: 'INPUT', type: 'password', name: 'user[password]', autoComplete: 'current-password',
  }, NO_MIRROR);
  assert.equal(fieldRejectsSpace(), false);
});

test('every address-shaped password name is exempt', () => {
  for (const name of ['user[password]', 'user_password', 'login_password',
                      'user-password', 'login[password]', 'account_user_password']) {
    const p = fakeProxy();
    applyImeHints(p, { tag: 'INPUT', type: 'password', name }, NO_MIRROR);
    assert.equal(fieldRejectsSpace(), false, name + ' would have its spaces stripped');
  }
});

test('a secret typed as type=text is exempt via its autocomplete token', () => {
  // Sites that roll their own masking ship type=text with the honest token.
  for (const ac of ['current-password', 'new-password', 'one-time-code']) {
    const p = fakeProxy();
    applyImeHints(p, { tag: 'INPUT', type: 'text', name: 'user_login', autoComplete: ac }, NO_MIRROR);
    assert.equal(fieldRejectsSpace(), false, ac + ' would have its spaces stripped');
  }
});

test('the address filter still fires on the fields it exists for', () => {
  // The exemption must not reinstate the Gboard trailing-space bug on the
  // username/email side, which is what the filter was built for.
  for (const hints of [
    { tag: 'INPUT', type: 'email' },
    { tag: 'INPUT', type: 'text', autoComplete: 'username' },
    { tag: 'INPUT', type: 'text', name: 'user[email]' },
    { tag: 'INPUT', type: 'text', name: 'login' },
  ]) {
    const p = fakeProxy();
    applyImeHints(p, hints, NO_MIRROR);
    assert.equal(fieldRejectsSpace(), true, JSON.stringify(hints) + ' should still reject spaces');
  }
});
