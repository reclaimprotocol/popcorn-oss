// Stop repeating gradient decorations from continuously repainting the VNC stream.
// Run in the extension isolated world; do not patch page APIs or globals.
(function() {
  'use strict';
  if (typeof document.getAnimations !== 'function') return;

  const metadata = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const motion = new Set(['backgroundPosition', 'backgroundPositionX',
    'backgroundPositionY', 'transform', 'translate']);

  function isTranslation(value) {
    if (value === 'none') return true;
    // Rotation and scale are intentionally excluded (e.g. progress spinners).
    if (/^(?:translate(?:X|Y|Z|3d)?\([^()]+\)\s*)+$/.test(value)) return true;
    const matrix = /^matrix\(([^()]+)\)$/.exec(value);
    if (!matrix) return false;
    const parts = matrix[1].split(',').map(Number);
    return parts.length === 6 && parts.every(Number.isFinite) &&
      parts[0] === 1 && parts[1] === 0 && parts[2] === 0 && parts[3] === 1;
  }

  function isGradientDecoration(animation) {
    const effect = animation.effect;
    if (typeof animation.animationName !== 'string' ||
        animation.playState !== 'running' ||
        effect?.getTiming().iterations !== Infinity ||
        !['::before', '::after'].includes(effect.pseudoElement)) return false;
    const frames = effect.getKeyframes();
    let hasMotion = false;
    for (const frame of frames) {
      for (const key of Object.keys(frame)) {
        if (metadata.has(key)) continue;
        if (!motion.has(key)) return false;
        if (key === 'transform' && !isTranslation(frame[key])) return false;
        hasMotion = true;
      }
    }
    return hasMotion && /(?:linear|radial|conic)-gradient\(/.test(
      getComputedStyle(effect.target, effect.pseudoElement).backgroundImage);
  }

  function pauseGradientDecorations() {
    for (const animation of document.getAnimations()) {
      try {
        if (isGradientDecoration(animation)) animation.pause();
      } catch (_) {
        // A component can detach or cancel its animation during this scan.
      }
    }
  }
  document.addEventListener('animationstart', pauseGradientDecorations, true);
  document.addEventListener('DOMContentLoaded', pauseGradientDecorations, { once: true });
  document.addEventListener('visibilitychange', pauseGradientDecorations);
  pauseGradientDecorations();
  // Catch page-driven restarts without scanning the DOM or patching playback APIs.
  setInterval(pauseGradientDecorations, 500);
})();
