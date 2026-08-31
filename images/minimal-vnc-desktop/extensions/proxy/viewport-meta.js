(function installPopcornViewportMeta(root) {
  'use strict';

  // Return the last value for a viewport directive. The viewport-meta syntax
  // accepts comma/semicolon separated directives; tolerating whitespace also
  // covers the compact forms commonly emitted by hand-written pages.
  function lastDirective(content, name) {
    const source = String(content || '');
    const pattern = new RegExp('(?:^|[,;\\s])' + name + '\\s*=\\s*([^,;\\s]+)', 'gi');
    let match = null;
    let value = null;
    while ((match = pattern.exec(source)) !== null) value = match[1].toLowerCase();
    return value;
  }

  function positiveNumber(value) {
    if (value === null || value === '') return false;
    const number = Number(value);
    return Number.isFinite(number) && number > 0;
  }

  function declaredLayoutWidth(content) {
    const width = lastDirective(content, 'width');
    if (width === 'device-width') return null;
    if (positiveNumber(width)) return Math.min(10000, Math.max(200, Number(width)));
    const initialScale = lastDirective(content, 'initial-scale');
    if (positiveNumber(initialScale)) return null;
    return 980;
  }

  // iOS Safari infers a device-sized layout viewport when initial-scale is set
  // and width is omitted. Only a missing viewport (or an explicit fixed width)
  // needs Popcorn's 980px legacy-page fallback.
  function requiresDesktopFallback(content) {
    return declaredLayoutWidth(content) !== null;
  }

  root.__POPCORN_VIEWPORT_META__ = Object.freeze({
    lastDirective,
    declaredLayoutWidth,
    requiresDesktopFallback,
  });
})(globalThis);
