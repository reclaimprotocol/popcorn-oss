// Unit tests for backspaceCountFor (kbd/keys.js) — the deletion-math that decides
// how many remote Backspaces a locally-deleted string is worth. Pure function, no
// DOM/RFB needed. Guards the Indic-ZWJ-conjunct regression: ZWJ/VS presence must
// NOT route a cluster to grapheme-counting, or Indic conjuncts under-delete and
// leave residual characters on the remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backspaceCountFor } from '../keys.js';

test('empty / falsy input is zero', () => {
  assert.equal(backspaceCountFor(''), 0);
  assert.equal(backspaceCountFor(undefined), 0);
  assert.equal(backspaceCountFor(null), 0);
});

test('plain ASCII counts per code unit', () => {
  assert.equal(backspaceCountFor('hello'), 5);
  assert.equal(backspaceCountFor('a'), 1);
});

test('CJK counts per code unit (Blink deletes per code point)', () => {
  assert.equal(backspaceCountFor('가나다'), 3);   // Hangul syllables
  assert.equal(backspaceCountFor('日本語'), 3);   // Han
});

test('Indic matras count per code unit', () => {
  // Devanagari "कि" = KA(U+0915) + vowel sign I(U+093F) = 2 code points
  assert.equal(backspaceCountFor('कि'), 2);
});

test('REGRESSION: Indic ZWJ conjunct counts per code unit, not per grapheme', () => {
  // Marathi eyelash-ra style conjunct: RA + VIRAMA + ZWJ + YA. Blink deletes
  // each code point, so a 4-code-unit conjunct must send 4 Backspaces. The old
  // EMOJIISH-includes-ZWJ heuristic grapheme-counted it -> 1 Backspace -> 3
  // residual chars left on the remote.
  const conjunct = 'र्‍य'; // RA, VIRAMA, ZWJ, YA
  assert.equal([...conjunct].length >= 4, true);
  assert.equal(backspaceCountFor(conjunct), conjunct.length);
});

test('simple emoji collapses to one Backspace', () => {
  assert.equal(backspaceCountFor('😀'), 1); // U+1F600, 2 code units, 1 grapheme
});

test('emoji ZWJ family collapses to one Backspace', () => {
  // 👨‍👩‍👧 = MAN ZWJ WOMAN ZWJ GIRL — one grapheme carrying pictographic scalars.
  const family = '👨‍👩‍👧';
  assert.equal([...family].length, 5); // 3 emoji + 2 ZWJ code points
  assert.equal(backspaceCountFor(family), 1);
});

test('flag (regional indicators) collapses to one Backspace', () => {
  assert.equal(backspaceCountFor('🇮🇳'), 1); // IN flag = 2 regional indicators
});

test('emoji with skin-tone modifier collapses to one', () => {
  assert.equal(backspaceCountFor('👍🏽'), 1); // thumbs up + medium skin tone
});

test('mixed run sums per-cluster: ascii + emoji + indic', () => {
  // "ab" (2) + 😀 (1) + "कि" (2) = 5
  assert.equal(backspaceCountFor('ab😀कि'), 5);
});

// The keys.js note names Devanagari, Tamil, Bengali and Malayalam as the scripts
// whose ZWJ/virama conjuncts Blink still deletes per code point. Only Devanagari
// was covered; a regression in the grapheme heuristic would have gone unnoticed
// in the other three, and under-deleting leaves residual characters in the field.
test('virama conjuncts count per code unit across Indic scripts', () => {
  const cases = [
    ['Devanagari क्ष', 'क्ष', 3],   // KA + VIRAMA + SSA
    ['Tamil க்ஷ',      'க்ஷ', 3],   // KA + VIRAMA + SSA
    ['Bengali ক্ষ',     'ক্ষ', 3],   // KA + VIRAMA + SSA
    ['Malayalam ക്ക',   'ക്ക', 3],   // KA + VIRAMA + KA
  ];
  for (const [name, s, expect] of cases) {
    assert.equal([...s].length, expect, name + ' should be ' + expect + ' code points');
    assert.equal(backspaceCountFor(s), expect, name + ' must send one Backspace per code point');
  }
});

test('a matra-bearing syllable deletes per code point, not per visual cluster', () => {
  // These render as ONE glyph cluster each but are multiple code points, which is
  // exactly the case a grapheme-collapsing heuristic gets wrong.
  for (const [s, n] of [['को', 2], ['தி', 2], ['কি', 2], ['കി', 2]]) {
    assert.equal(backspaceCountFor(s), n, JSON.stringify(s));
  }
});

test('Indic mixed with emoji: only the emoji collapses', () => {
  // 'क्ष' (3) + family emoji (1) + 'कि' (2) = 6
  assert.equal(backspaceCountFor('क्ष\u{1F468}‍\u{1F469}‍\u{1F467}कि'), 6);
});
