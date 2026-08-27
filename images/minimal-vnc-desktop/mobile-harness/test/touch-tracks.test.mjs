import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTouchTracks, coordinateExpression, recordingTimeline } from '../src/touch-tracks.mjs';

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

test('the overlay timeline covers the run even when screenrecord barely recorded', () => {
  // Measured on an emulator: double-tap-no-zoom, a case whose whole point is that
  // nothing changes on screen. screenrecord emitted 3 frames spanning 3.13s for a
  // 3.8s run, so both taps (at +3.31s and +3.77s) fell past the encoded end and
  // the mandatory overlay was refused for a case that had actually passed.
  const short = recordingTimeline({ recordedDuration: 3.131, sourceFrames: 3, wallClockSeconds: 3.8 });
  assert.equal(short.mode, 'hold-last-frame', 'keep the real frames, hold the last');
  assert.equal(short.duration, 3.8, 'the timeline covers the whole run');
  assert.equal(short.padSeconds, 0.669);
  assert.equal(short.extended, true);
});

test('a single-frame recording still loops that frame', () => {
  const one = recordingTimeline({ recordedDuration: 0.03, sourceFrames: 1, wallClockSeconds: 6 });
  assert.equal(one.mode, 'loop-single-frame');
  assert.equal(one.duration, 6);
  assert.equal(one.padSeconds, 0, 'looping needs no pad');
});

test('a recording that covers the run is used exactly as recorded', () => {
  const full = recordingTimeline({ recordedDuration: 5.4, sourceFrames: 160, wallClockSeconds: 5.2 });
  assert.equal(full.mode, 'as-recorded');
  assert.equal(full.duration, 5.4, 'no invented time');
  assert.equal(full.extended, false);
});

test('a quarter second of slack is not treated as a short recording', () => {
  // Encoding ends a frame or two before the last action; that is not the bug.
  const close = recordingTimeline({ recordedDuration: 3.7, sourceFrames: 90, wallClockSeconds: 3.8 });
  assert.equal(close.mode, 'as-recorded');
});

test('missing ffprobe metadata falls back to the wall clock', () => {
  for (const bad of [{ recordedDuration: NaN, sourceFrames: 12 }, { recordedDuration: 0, sourceFrames: 12 }]) {
    const t = recordingTimeline({ ...bad, wallClockSeconds: 4 });
    assert.equal(t.mode, 'loop-single-frame');
    assert.equal(t.duration, 4);
  }
});
