import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTouchTracks, coordinateExpression } from '../src/touch-tracks.mjs';

const origin = Date.parse('2026-08-27T00:00:00.000Z');
const at = (milliseconds) => new Date(origin + milliseconds).toISOString();
const options = {
  origin,
  duration: 5,
  videoWidth: 1080,
  videoHeight: 2400,
  windowWidth: 1080,
  windowHeight: 2400,
};

test('pinch produces two continuous finger tracks', () => {
  const tracks = buildTouchTracks([{
    name: 'pinch-map',
    touches: [
      { kind: 'pinch-left-start', x: 500, y: 1000, at: at(1000) },
      { kind: 'pinch-right-start', x: 580, y: 1000, at: at(1000) },
      { kind: 'pinch-left-end', x: 420, y: 1000, at: at(2000) },
      { kind: 'pinch-right-end', x: 660, y: 1000, at: at(2000) },
    ],
  }], options);

  assert.deepEqual(tracks.map((track) => track.kind), ['pinch-left', 'pinch-right']);
  assert.deepEqual(tracks.map((track) => track.points.length), [2, 2]);
  assert.match(coordinateExpression(tracks[0], 'x'), /-80\*\(t-1\)/);
  assert.match(coordinateExpression(tracks[1], 'x'), /\+80\*\(t-1\)/);
});

test('pan marker follows the complete swipe instead of flashing at endpoints', () => {
  const [track] = buildTouchTracks([{
    name: 'pan-map',
    touches: [
      { kind: 'swipe-start', x: 900, y: 1200, at: at(2500) },
      { kind: 'swipe-end', x: 200, y: 1200, at: at(3300) },
    ],
  }], options);

  assert.equal(track.kind, 'swipe');
  assert.equal(track.points.length, 2);
  assert.equal(track.motionStart, 2.5);
  assert.equal(track.motionEnd, 3.3);
  assert.match(coordinateExpression(track, 'x'), /-700\*\(t-2.5\)/);
});

test('tap remains a short stationary marker', () => {
  const [track] = buildTouchTracks([{
    name: 'tap-marker',
    touches: [{ kind: 'tap', x: 540, y: 900, at: at(4000) }],
  }], options);

  assert.equal(track.kind, 'tap');
  assert.equal(track.visibleStart, 3.88);
  assert.equal(track.visibleEnd, 4.6);
  assert.equal(coordinateExpression(track, 'x'), '492');
});
