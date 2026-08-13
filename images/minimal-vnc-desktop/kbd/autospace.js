// autospace.js — SwiftKey auto-space stripper (verbatim logic from video.vue).
//
// SwiftKey (Android) injects a space after punctuation that the user did not
// type; strip it so the remote field gets exactly the intended text. iOS's own
// auto-space (double-space → ". ") is intentional and must pass through — the
// isAndroid guard lives here rather than at the call sites because the iOS
// mirror value-diff reuses the same code path.
//
// createAutoSpaceFilter({ getSensitiveField }) owns the cross-event context
// (lastCharSent / lastPunctuationTime) the stripper needs to catch a space that
// arrives as its own event right after the punctuation.

import { isAndroid } from './env.js';

const PUNCTUATION = new Set(['!', '.', ',', '?', ':', ';', "'", '"', ')', ']', '}']);

export function createAutoSpaceFilter({ getSensitiveField }) {
  let lastCharSent = '';       // cross-event context: last char we forwarded
  let lastPunctuationTime = 0; // when we last forwarded punctuation

  function filter(chars) {
    if (chars.length === 0) return chars;
    if (!isAndroid) return chars;
    // Never touch a password/OTP/card field: a silently-stripped space in an
    // invisible secret (a passphrase with '. ' or '! ') produces a failed login
    // with zero feedback, and drift-recon is disabled on sensitive fields so the
    // corruption is undetectable. Send exactly what was typed.
    if (getSensitiveField()) return chars;
    const now = Date.now();
    let result = '';
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const prevChar = i > 0 ? chars[i - 1] : lastCharSent;
      const timeSincePunctuation = now - lastPunctuationTime;
      // Strip a SwiftKey-injected auto-space after punctuation — but ONLY the two
      // shapes it actually delivers, never a legitimate space inside a phrase:
      //   * a lone leading space (i === 0) arriving as its own event right after
      //     the punctuation was committed in a PRIOR event (cross-event time gate);
      //   * a bare punctuation+space PAIR committed together in one step.
      // A multi-word batch ('Hello. World' from glide/voice/paste) has its space at
      // i>0 in a length>2 batch, so neither clause fires and the space survives.
      // (The old `i > 0` clause stripped ANY intra-batch space-after-punctuation,
      // silently deleting real spaces from multi-word inserts.)
      const swiftKeyAutoSpace =
        (i === 0 && timeSincePunctuation < 100) || (chars.length === 2 && i === 1);
      if (char === ' ' && PUNCTUATION.has(prevChar) && swiftKeyAutoSpace) continue;
      result += char;
      if (PUNCTUATION.has(char)) lastPunctuationTime = now;
    }
    if (result.length > 0) lastCharSent = result[result.length - 1];
    return result;
  }

  return { filter };
}
