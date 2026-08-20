// diag-geometry.js — compact, content-free geometry formatting for diagnostics.
//
// Remote element positions are useful when investigating a tap miss, but logs
// must stay bounded even on pages with many editable controls.

function px(n) { return Number.isFinite(n) ? Math.round(n) : '?'; }

export function formatPoint(x, y) {
  return px(x) + ',' + px(y);
}

export function formatPoints(points, max = 4) {
  if (!Array.isArray(points) || !points.length) return '[]';
  const shown = points.slice(0, max).map((p) => formatPoint(p.x, p.y));
  return '[' + shown.join(',') + (points.length > max ? ',+' + (points.length - max) : '') + ']';
}

export function formatRects(rects, max = 8) {
  if (!Array.isArray(rects) || !rects.length) return '[]';
  const shown = rects.slice(0, max).map((r) =>
    '(' + px(r.x) + ',' + px(r.y) + ' ' + px(r.w) + 'x' + px(r.h) + ')');
  return '[' + shown.join(',') + (rects.length > max ? ',+' + (rects.length - max) : '') + ']';
}
