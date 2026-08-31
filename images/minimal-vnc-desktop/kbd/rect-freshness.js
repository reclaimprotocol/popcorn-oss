// rect-freshness.js — is a published rect still where the pixels are?
//
// The extension's rects are viewport-relative, so they only mean anything at the
// scroll offset they were measured at. A page still gliding under a fling
// publishes a new offset with every state, and a local hit target placed from one
// of those sits beside the control the user sees. Two states agreeing on the
// offset prove the page has settled. A publisher that never reports one cannot be
// judged, so it keeps the unguarded behaviour rather than losing its control to a
// version skew.

export function createRectFreshness() {
  let last = null;
  let steady = null;
  let reported = false;
  return {
    fresh: () => !reported || steady !== null,
    note(sy) {
      if (typeof sy !== 'number') return;
      reported = true;
      steady = sy === last ? sy : null;
      last = sy;
    },
    stale() { steady = null; },
  };
}
