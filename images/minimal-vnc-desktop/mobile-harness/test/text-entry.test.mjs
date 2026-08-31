import assert from 'node:assert/strict';
import test from 'node:test';

import {
  androidInputTextCommand,
  androidKeyeventCommand,
  editorKeyNames,
  iosKeySequence,
  nativeElementSelector,
} from '../src/text-entry.mjs';

test('android text is quoted for the device shell, not the local one', () => {
  assert.deepEqual(androidInputTextCommand('abc'), ['shell', "input text 'abc'"]);
  // A space must survive: adb joins argv into one string that the device sh parses.
  assert.deepEqual(androidInputTextCommand('two words'), ['shell', "input text 'two words'"]);
  // Shell metacharacters must not reach the device shell unquoted.
  assert.deepEqual(androidInputTextCommand('a;rm -rf b'), ['shell', "input text 'a;rm -rf b'"]);
  assert.deepEqual(androidInputTextCommand('a$(id)`id`'), ['shell', "input text 'a$(id)`id`'"]);
  assert.deepEqual(androidInputTextCommand("it's"), ['shell', "input text 'it'\\''s'"]);
});

test('android text refuses input `input text` would reinterpret', () => {
  // `input text` turns %s into a space before typing, so % is not typeable.
  assert.throws(() => androidInputTextCommand('100%s'), /cannot contain %/);
  assert.throws(() => androidInputTextCommand(''), /non-empty/);
  assert.throws(() => androidInputTextCommand(undefined), /non-empty/);
});

test('editor keys map to real keyevents and iOS sequences', () => {
  assert.deepEqual(androidKeyeventCommand('enter'), ['shell', 'input keyevent 66']);
  assert.deepEqual(androidKeyeventCommand('BackSpace'.toLowerCase()), ['shell', 'input keyevent 67']);
  assert.deepEqual(androidKeyeventCommand('back'), ['shell', 'input keyevent 4']);
  // A field with enterkeyhint=next advances on Enter, so next and enter agree.
  assert.deepEqual(androidKeyeventCommand('next'), androidKeyeventCommand('enter'));
  assert.equal(iosKeySequence('enter'), '\n');
  assert.equal(iosKeySequence('tab'), '\t');
  assert.equal(iosKeySequence('backspace'), '');
  for (const key of editorKeyNames()) {
    assert.ok(androidKeyeventCommand(key), `${key} needs an Android keyevent`);
    assert.ok(iosKeySequence(key).length > 0, `${key} needs a non-empty iOS sequence`);
  }
});

test('an unknown key names the supported set instead of failing on the device', () => {
  assert.throws(() => androidKeyeventCommand('anykey'), /expected one of .*enter/);
  assert.throws(() => iosKeySequence('anykey'), /expected one of .*enter/);
});

test('native selectors are built per platform', () => {
  assert.equal(nativeElementSelector({ android: { text: '11' } }, 'Android'),
    'android=new UiSelector().text("11")');
  assert.equal(nativeElementSelector({ android: { resourceId: 'android:id/button1' } }, 'Android'),
    'android=new UiSelector().resourceId("android:id/button1")');
  assert.equal(nativeElementSelector({ android: { uiSelector: 'new UiSelector().index(2)' } }, 'Android'),
    'android=new UiSelector().index(2)');
  assert.equal(nativeElementSelector({ ios: { label: 'Done' } }, 'iOS'),
    '-ios predicate string:label == "Done"');
  assert.equal(nativeElementSelector({ ios: { predicate: 'type == "XCUIElementTypeButton"' } }, 'iOS'),
    '-ios predicate string:type == "XCUIElementTypeButton"');
});

test('a selector missing the running platform fails before the tap', () => {
  // Silently skipping would let a case report success without selecting anything.
  assert.throws(() => nativeElementSelector({ ios: { label: 'Done' } }, 'Android'), /android selector/);
  assert.throws(() => nativeElementSelector({ android: { text: '11' } }, 'iOS'), /ios selector/);
  assert.throws(() => nativeElementSelector({ android: {} }, 'Android'), /uiSelector, resourceId/);
  assert.throws(() => nativeElementSelector({ ios: {} }, 'iOS'), /predicate, label/);
});
