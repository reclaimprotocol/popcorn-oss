import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual viewer boundary without importing noVNC's DOM-heavy
// bootstrap. The runtime pins noVNC v1.6.0 (locks/novnc.lock).
const source = readFileSync(new URL('../../viewer.js', import.meta.url), 'utf8');
const start = source.indexOf('function installPointerTransformFix(instance) {');
const end = source.indexOf('// In magnify mode', start);
assert.ok(start >= 0 && end > start);

function fixture(desktop = true) {
  const calls = [], reports = [], logs = [];
  const canvas = { clientWidth: 400, clientHeight: 200,
    getBoundingClientRect: () => ({ width: 800, height: 400 }) };
  const install = new Function('screen', 'reportInteraction', 'dbg', 'DESKTOP',
    source.slice(start, end) + '\nreturn installPointerTransformFix;')(
    { querySelector: () => canvas }, (...args) => reports.push(args), line => logs.push(line), desktop);
  const instance = {
    _rfbConnectionState: 'connected', _viewOnly: false, _mouseButtonMask: 0,
    _handleMouseButton(x, y, mask) {
      calls.push({ self: this, args: [x, y, mask] });
      this._mouseButtonMask = mask;
      return 'sent';
    },
    _handleMouseMove(...args) { calls.push({ self: this, args }); return 'moved'; },
  };
  install(instance);
  return { instance, calls, reports, logs, install };
}

test('physical press reports once and preserves forwarding, coordinates, this and return value', () => {
  const { instance, calls, reports, logs } = fixture();
  assert.equal(instance._handleMouseButton(80, 40, 1), 'sent');
  instance._handleMouseButton(80, 40, 1); // repeated held mask
  instance._handleMouseButton(80, 40, 0); // release
  assert.deepEqual(calls[0].args, [40, 20, 1]);
  assert.equal(calls[0].self, instance);
  assert.deepEqual(reports, [['click']]);
  assert.deepEqual(logs, ['pointer click forwarded']);
});

test('movement and wheel pulses are not clicks, including a wheel pulse while held', () => {
  const { instance, reports } = fixture();
  assert.equal(instance._handleMouseMove(80, 40), 'moved');
  for (const mask of [8, 0, 16, 0, 32, 0, 64, 0]) instance._handleMouseButton(0, 0, mask);
  assert.deepEqual(reports, []);
  instance._handleMouseButton(0, 0, 1);
  instance._handleMouseButton(0, 0, 9);
  instance._handleMouseButton(0, 0, 1);
  assert.deepEqual(reports, [['click']]);
});

test('touch compatibility clicks retain layout coordinates and do not report twice', () => {
  const { instance, calls, reports } = fixture();
  instance.__pcnPointerCoordsAreLayout = true;
  for (const mask of [0, 1, 0]) instance._handleMouseButton(80, 40, mask);
  assert.deepEqual(calls[1].args, [80, 40, 1]);
  assert.deepEqual(reports, []);
});

test('view-only and disconnected instances do not claim forwarded input', () => {
  const { instance, reports } = fixture();
  instance._viewOnly = true;
  instance._handleMouseButton(0, 0, 1);
  instance._handleMouseButton(0, 0, 0);
  instance._viewOnly = false;
  instance._rfbConnectionState = 'disconnected';
  instance._handleMouseButton(0, 0, 1);
  assert.deepEqual(reports, []);
});

test('native noVNC touch gestures leave reporting to the existing tap path', () => {
  const { instance, calls, reports } = fixture(false);
  instance._handleMouseButton(80, 40, 1);
  instance._handleMouseButton(80, 40, 0);
  assert.equal(calls.length, 2, 'touch still forwards without a layout marker');
  assert.deepEqual(reports, []);
});

test('diagnostic lines are capped while all desktop clicks keep reporting', () => {
  const { instance, reports, logs } = fixture();
  for (let i = 0; i < 100; i++) {
    instance._handleMouseButton(0, 0, 1);
    instance._handleMouseButton(0, 0, 0);
  }
  assert.equal(reports.length, 100);
  assert.equal(logs.length, 32);
});

test('replacement connections report their own presses and handler errors propagate', () => {
  const { install, reports } = fixture();
  const replacement = { _rfbConnectionState: 'connected', _mouseButtonMask: 0,
    _handleMouseButton() { return 42; } };
  install(replacement);
  assert.equal(replacement._handleMouseButton(0, 0, 1), 42);
  assert.deepEqual(reports, [['click']]);
  const broken = { ...replacement, _handleMouseButton() { throw new Error('closed'); } };
  install(broken);
  assert.throws(() => broken._handleMouseButton(0, 0, 1), /closed/);
  assert.equal(reports.length, 1);
});
