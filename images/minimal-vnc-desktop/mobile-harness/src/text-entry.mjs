// text-entry.mjs — surface-independent text entry, editor keys, and native-element
// addressing.
//
// A case that taps on-screen keyboard KEYS only ever passes on the surface it was
// calibrated against: the same letter sits at a different screen position in Chrome,
// in a chrome-less web view and in Firefox (different chrome heights), and moves
// again with the keyboard app (Gboard and the AOSP keyboard disagree). Measured, `q`
// is at y=613 in an iOS simulator and y=1715 on Android — which is why the
// tap-per-key cases carried per-platform overrides and still only ran on one surface.
//
// Both platforms can instead put text into the focused field through their own input
// path: `input text` on Android goes through the IME, and XCUITest's typeText drives
// the real on-screen keyboard. Neither depends on where a key is painted.
//
// This module holds only the decisions — escaping, key names, selector syntax — so
// they are testable without a device. cli.mjs owns the adb and driver calls.

const ANDROID_KEYEVENTS = {
  enter: 66,      // KEYCODE_ENTER — also what an enterkeyhint=next field acts on
  next: 66,
  done: 66,
  search: 66,
  backspace: 67,  // KEYCODE_DEL
  tab: 61,
  escape: 111,
  back: 4,        // dismisses the IME without moving focus
};

// XCUITest types these through the keyboard the same way a person would.
const IOS_KEY_SEQUENCES = {
  enter: '\n',
  next: '\n',
  done: '\n',
  search: '\n',
  backspace: '\u0008',  // XCUIKeyboardKeyDelete
  tab: '\t',
  escape: '\u001b',
  back: '\u001b',   // iOS has no Back key; Escape is the closest dismissal
};

export function editorKeyNames() {
  return Object.keys(ANDROID_KEYEVENTS).sort();
}

// `adb shell` joins argv into one string that the DEVICE shell parses, so the text
// needs device-side quoting, not local quoting. Single-quote everything and escape
// embedded quotes the POSIX way ('\'' closes, escapes, reopens).
export function androidInputTextCommand(text) {
  const value = String(text ?? '');
  if (!value) throw new Error('typeText requires a non-empty text');
  // `input text` substitutes %s for a space before typing, so a literal % in the
  // text would be read as markup rather than typed.
  if (value.includes('%')) throw new Error('typeText text cannot contain % on Android (input text reads %s as a space)');
  return ['shell', `input text '${value.replace(/'/g, "'\\''")}'`];
}

export function androidKeyeventCommand(key) {
  const code = ANDROID_KEYEVENTS[String(key ?? '').toLowerCase()];
  if (!code) throw new Error(`Unsupported key ${key}; expected one of ${editorKeyNames().join(', ')}`);
  return ['shell', `input keyevent ${code}`];
}

export function iosKeySequence(key) {
  const sequence = IOS_KEY_SEQUENCES[String(key ?? '').toLowerCase()];
  if (!sequence) throw new Error(`Unsupported key ${key}; expected one of ${editorKeyNames().join(', ')}`);
  return sequence;
}

// Native pickers (date wheels, select dialogs, IME accessory rows) are OS windows:
// they carry no fixture colors, so a framebuffer marker cannot address them. They do
// expose accessibility text, which is stable across browsers and web views.
export function nativeElementSelector(action, platform) {
  const spec = platform === 'Android' ? action?.android : action?.ios;
  if (!spec) throw new Error(`tapNativeElement requires a ${platform === 'Android' ? 'android' : 'ios'} selector`);
  if (platform === 'Android') {
    if (spec.uiSelector) return `android=${spec.uiSelector}`;
    if (spec.resourceId) return `android=new UiSelector().resourceId("${spec.resourceId}")`;
    if (spec.text) return `android=new UiSelector().text("${spec.text}")`;
    if (spec.description) return `android=new UiSelector().description("${spec.description}")`;
    throw new Error('Android selector needs uiSelector, resourceId, text, or description');
  }
  if (spec.predicate) return `-ios predicate string:${spec.predicate}`;
  if (spec.label) return `-ios predicate string:label == "${spec.label}"`;
  if (spec.name) return `-ios predicate string:name == "${spec.name}"`;
  throw new Error('iOS selector needs predicate, label, or name');
}
