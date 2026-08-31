// android-ui.mjs — finding a native element in a uiautomator hierarchy.
//
// The Android side of this harness has no WebDriver connection at all: it drives the
// device with `adb exec-out screencap` and `adb shell input`, and declares
// `elementAccess: false`. So a native picker cannot be addressed with an Appium
// selector here — but it can be addressed the same way everything else is, by dumping
// the accessibility hierarchy and tapping a resolved point.
//
// That matters for pickers specifically: a date wheel or select dialog is an OS window
// that carries no fixture colors, so the framebuffer has no marker to aim at, while
// the hierarchy exposes stable text ("29", "Business", android:id/button1).
//
// Parsing and geometry live here so they can be tested against real captured dumps.

const NODE = /<node\b[^>]*\/?>/g;

function attribute(node, name) {
  const match = node.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : '';
}

export function parseHierarchy(xml) {
  const nodes = [];
  for (const raw of String(xml ?? '').match(NODE) ?? []) {
    const bounds = attribute(raw, 'bounds').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    nodes.push({
      text: attribute(raw, 'text'),
      description: attribute(raw, 'content-desc'),
      resourceId: attribute(raw, 'resource-id'),
      className: attribute(raw, 'class'),
      scrollable: attribute(raw, 'scrollable') === 'true',
      enabled: attribute(raw, 'enabled') !== 'false',
      bounds: bounds && {
        left: Number(bounds[1]), top: Number(bounds[2]), right: Number(bounds[3]), bottom: Number(bounds[4]),
      },
    });
  }
  return nodes;
}

// A node with no area cannot be tapped: an off-screen picker row reports a collapsed
// or negative rectangle, and tapping its "centre" would hit whatever is there instead.
export function isTappable(node) {
  const b = node?.bounds;
  return Boolean(b) && b.right > b.left && b.bottom > b.top && b.right > 0 && b.bottom > 0;
}

export function nodeCenter(node) {
  const b = node.bounds;
  return { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) };
}

export function describeSpec(spec) {
  return Object.entries(spec ?? {})
    .filter(([key]) => ['text', 'description', 'resourceId', 'textContains'].includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ') || '(empty selector)';
}

export function matchNodes(nodes, spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Android selector must be an object');
  const { text, textContains, description, resourceId } = spec;
  if (text === undefined && textContains === undefined && description === undefined && resourceId === undefined) {
    throw new Error('Android selector needs text, textContains, description, or resourceId');
  }
  return nodes.filter((node) => {
    if (text !== undefined && node.text !== String(text)) return false;
    if (textContains !== undefined && !node.text.includes(String(textContains))) return false;
    if (description !== undefined && node.description !== String(description)) return false;
    if (resourceId !== undefined && node.resourceId !== String(resourceId)) return false;
    return true;
  });
}

// The visible match, not merely the first: a NumberPicker keeps its off-screen values
// in the hierarchy, and a long select list reports rows above and below the viewport.
export function resolveTapTarget(xml, spec) {
  const nodes = parseHierarchy(xml);
  const matches = matchNodes(nodes, spec);
  const tappable = matches.filter(isTappable);
  const index = Number(spec.instance ?? 0);
  if (!Number.isInteger(index) || index < 0) throw new Error(`Android selector instance must be a whole number, got ${spec.instance}`);
  const chosen = tappable[index];
  return {
    found: Boolean(chosen),
    matches: matches.length,
    tappable: tappable.length,
    point: chosen ? nodeCenter(chosen) : null,
    node: chosen ?? null,
  };
}

// Where to swipe to bring more of a list into view. uiautomator's own scrollIntoView is
// not available without a WebDriver, so the caller repeats a swipe inside the
// scrollable node's own rectangle — outside it the gesture scrolls something else.
export function scrollGestureFor(xml, { direction = 'down' } = {}) {
  const scrollables = parseHierarchy(xml).filter((node) => node.scrollable && isTappable(node));
  if (!scrollables.length) return null;
  // The largest scrollable is the list itself rather than a container that happens to
  // be scrollable.
  const target = scrollables.sort((a, b) => area(b) - area(a))[0];
  const { left, right, top, bottom } = target.bounds;
  const x = Math.round((left + right) / 2);
  const height = bottom - top;
  const inset = Math.round(height * 0.2);
  const near = top + inset;
  const far = bottom - inset;
  return direction === 'down'
    ? { fromX: x, fromY: far, toX: x, toY: near, durationMs: 350 }
    : { fromX: x, fromY: near, toX: x, toY: far, durationMs: 350 };
}

function area(node) {
  const b = node.bounds;
  return (b.right - b.left) * (b.bottom - b.top);
}
