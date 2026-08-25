import assert from 'node:assert/strict';

await import('../extensions/proxy/viewport-meta.js');

const { declaredLayoutWidth, lastDirective, requiresDesktopFallback } = globalThis.__POPCORN_VIEWPORT_META__;

const cases = [
  ['', true, 'missing declarations'],
  ['maximum-scale=10', true, 'maximum-scale alone'],
  ['width=device-width, initial-scale=1', false, 'standard responsive viewport'],
  ['WIDTH = DEVICE-WIDTH ; initial-scale = 1.0', false, 'case and separators'],
  ['initial-scale=1, maximum-scale=10', false, 'TestUFO initial-scale-only viewport'],
  ['initial-scale=.5', false, 'positive fractional initial scale'],
  ['width=590, initial-scale=1', true, 'explicit fixed-width viewport'],
  ['width=invalid, initial-scale=1', false, 'invalid width does not suppress scale inference'],
  ['initial-scale=0', true, 'non-positive initial scale'],
  ['initial-scale=nope', true, 'invalid initial scale'],
];

for (const [content, expected, label] of cases) {
  assert.equal(requiresDesktopFallback(content), expected, label);
}

assert.equal(lastDirective('width=980; width=device-width', 'width'), 'device-width');
assert.equal(lastDirective('initial-scale=1 maximum-scale=10', 'initial-scale'), '1');
assert.equal(declaredLayoutWidth('width=720'), 720);
assert.equal(declaredLayoutWidth('width=120'), 200, 'numeric widths use Safari minimum');
assert.equal(declaredLayoutWidth('initial-scale=1, maximum-scale=10'), null);
assert.equal(declaredLayoutWidth('maximum-scale=10'), 980);

console.log(`${cases.length + 6} viewport-meta checks passed`);
