import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const analyzer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'vision-text.swift');

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function uniqueText(observations, minimumConfidence) {
  const grouped = new Map();
  for (const observation of observations ?? []) {
    if (Number(observation.confidence) < minimumConfidence) continue;
    const text = normalizedText(observation.text);
    if (text.length < 4) continue;
    const values = grouped.get(text) ?? [];
    values.push(observation);
    grouped.set(text, values);
  }
  return new Map([...grouped].filter(([, values]) => values.length === 1).map(([text, values]) => [text, values[0]]));
}

export function compareTextGeometry(baselineObservations, candidateObservations, options = {}) {
  const minimumConfidence = Number(options.minimumConfidence ?? 0.45);
  const minimumMatches = Number(options.minimumMatches ?? 3);
  const minimumScale = Number(options.minimumScale ?? 0.72);
  const maximumScale = Number(options.maximumScale ?? 1.4);
  const baseline = uniqueText(baselineObservations, minimumConfidence);
  const candidate = uniqueText(candidateObservations, minimumConfidence);
  const matches = [];
  for (const [text, before] of baseline) {
    const after = candidate.get(text);
    if (!after || before.height <= 0 || before.width <= 0 || after.height <= 0 || after.width <= 0) continue;
    matches.push({
      text,
      heightScale: after.height / before.height,
      widthScale: after.width / before.width,
      baseline: { x: before.x, y: before.y, width: before.width, height: before.height },
      candidate: { x: after.x, y: after.y, width: after.width, height: after.height },
    });
  }
  const medianTextHeightScale = median(matches.map((match) => match.heightScale));
  const passed = matches.length >= minimumMatches
    && medianTextHeightScale >= minimumScale
    && medianTextHeightScale <= maximumScale;
  return {
    passed,
    matchedTextCount: matches.length,
    minimumMatches,
    medianTextHeightScale,
    permittedTextHeightScale: { minimum: minimumScale, maximum: maximumScale },
    matches: matches.sort((a, b) => a.text.localeCompare(b.text)).slice(0, 40),
  };
}

export function analyzeViewportScreenshots(checkpoints, options = {}) {
  const files = [...new Set(checkpoints.flatMap((checkpoint) => [checkpoint.baselineFile, checkpoint.candidateFile]))];
  const result = spawnSync('swift', [analyzer, ...files], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: Number(options.timeoutMs ?? 120000),
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Vision viewport analysis timed out');
  if (result.status !== 0) throw new Error(`Vision viewport analysis failed: ${(result.stderr || result.stdout).trim()}`);
  const observations = new Map(JSON.parse(result.stdout).map((entry) => [path.resolve(entry.path), entry.observations]));
  const results = checkpoints.map((checkpoint) => ({
    name: checkpoint.name,
    ...compareTextGeometry(
      observations.get(path.resolve(checkpoint.baselineFile)) ?? [],
      observations.get(path.resolve(checkpoint.candidateFile)) ?? [],
      options,
    ),
  }));
  return {
    method: 'apple-vision-visible-text-geometry',
    source: 'simulator-framebuffer-screenshots',
    enforced: options.enforce !== false,
    passed: results.every((checkpoint) => checkpoint.passed),
    checkpoints: results,
  };
}
