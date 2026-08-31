function finiteTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function actionTouches(action) {
  if (Array.isArray(action.touches)) return action.touches;
  if (Array.isArray(action.observation?.touches)) return action.observation.touches;
  if (action.observation?.touch) return [action.observation.touch];
  return [];
}

function trackKey(kind) {
  const match = String(kind ?? '').match(/^(.*)-(start|end)$/);
  return match ? { key: match[1], phase: match[2] } : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function buildTouchTracks(actions, options) {
  const {
    origin,
    duration,
    videoWidth,
    videoHeight,
    windowWidth,
    windowHeight,
    indicatorRadius = 48,
  } = options;
  if (![origin, duration, videoWidth, videoHeight, windowWidth, windowHeight].every(Number.isFinite)) {
    throw new Error('Touch tracking requires finite video timeline and dimensions');
  }

  const tracks = [];
  for (const [actionIndex, action] of (actions ?? []).entries()) {
    const touches = actionTouches(action);
    const paired = new Map();
    for (const [touchIndex, touch] of touches.entries()) {
      const at = finiteTimestamp(touch.at);
      if (at === null || !Number.isFinite(Number(touch.x)) || !Number.isFinite(Number(touch.y))) continue;
      const point = {
        kind: String(touch.kind ?? 'touch'),
        x: Number(touch.x),
        y: Number(touch.y),
        seconds: (at - origin) / 1000,
        at: touch.at,
      };
      const pair = trackKey(point.kind);
      if (!pair) {
        const visibleStart = Math.max(0, point.seconds - 0.12);
        const visibleEnd = Math.min(duration, point.seconds + 0.6);
        if (visibleEnd > visibleStart) {
          tracks.push({
            id: `${actionIndex}-${touchIndex}`,
            kind: point.kind,
            action: action.name ?? action.type ?? `action-${actionIndex}`,
            points: [point],
            motionStart: point.seconds,
            motionEnd: point.seconds,
            visibleStart,
            visibleEnd,
          });
        }
        continue;
      }
      const entry = paired.get(pair.key) ?? { key: pair.key, points: [] };
      entry.points.push({ ...point, phase: pair.phase });
      paired.set(pair.key, entry);
    }

    for (const entry of paired.values()) {
      const points = entry.points.sort((left, right) => left.seconds - right.seconds);
      if (!points.length) continue;
      const first = points[0];
      const last = points.at(-1);
      const visibleStart = Math.max(0, first.seconds - 0.12);
      const visibleEnd = Math.min(duration, last.seconds + 0.35);
      if (visibleEnd <= visibleStart) continue;
      tracks.push({
        id: `${actionIndex}-${entry.key}`,
        kind: entry.key,
        action: action.name ?? action.type ?? `action-${actionIndex}`,
        points,
        motionStart: first.seconds,
        motionEnd: last.seconds,
        visibleStart,
        visibleEnd,
      });
    }
  }

  return tracks.map((track) => ({
    ...track,
    points: track.points.map((point) => ({
      ...point,
      videoX: clamp(Math.round(point.x * videoWidth / windowWidth - indicatorRadius), -indicatorRadius, videoWidth),
      videoY: clamp(Math.round(point.y * videoHeight / windowHeight - indicatorRadius), -indicatorRadius, videoHeight),
    })),
  }));
}

export function coordinateExpression(track, axis) {
  const points = track.points;
  const first = points[0];
  const last = points.at(-1);
  const key = axis === 'x' ? 'videoX' : 'videoY';
  if (points.length < 2 || track.motionEnd <= track.motionStart) return String(first[key]);
  const start = Number(track.motionStart.toFixed(3));
  const end = Number(track.motionEnd.toFixed(3));
  const delta = last[key] - first[key];
  return `if(lt(t,${start}),${first[key]},if(gt(t,${end}),${last[key]},${first[key]}+${delta}*(t-${start})/${Math.max(0.001, end - start)}))`;
}

// How long the overlay timeline should be, and how the source has to be stretched
// to cover it.
//
// screenrecord emits frames only when the screen CHANGES, so a case whose whole
// point is that nothing changes (a double tap that must NOT zoom) produced a
// 3-frame, 3.13s file for a 3.8s run — and every real touch then fell after the
// encoded end, so the mandatory overlay was refused for a case that had passed.
// The encoded duration is only trustworthy when it actually covers the run.
export function recordingTimeline({ recordedDuration, sourceFrames, wallClockSeconds }) {
  const wall = Math.max(1, Number(wallClockSeconds) || 0);
  const encoded = Number(recordedDuration);
  const frames = Number(sourceFrames);
  const singleFrame = !Number.isFinite(encoded) || encoded <= 0 || !(frames > 1);
  const short = !singleFrame && encoded + 0.25 < wall;
  return {
    duration: singleFrame || short ? wall : encoded,
    // loop the one frame we have, hold the last of the few we have, or neither
    mode: singleFrame ? 'loop-single-frame' : short ? 'hold-last-frame' : 'as-recorded',
    padSeconds: short ? Number((wall - encoded).toFixed(3)) : 0,
    extended: singleFrame || short,
  };
}
