import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

export function stagingDirectory(finalDirectory, nonce = `${process.pid}-${Date.now().toString(36)}`) {
  return `${path.resolve(finalDirectory)}.in-progress-${nonce}`;
}

export function removeStaleStagingDirectories(finalDirectory) {
  const final = path.resolve(finalDirectory);
  const parent = path.dirname(final);
  const prefix = `${path.basename(final)}.in-progress-`;
  const removed = [];
  if (!existsSync(parent)) return removed;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const directory = path.join(parent, entry.name);
    rmSync(directory, { recursive: true, force: true });
    removed.push(directory);
  }
  return removed.sort();
}

// Replace a completed case directory without exposing a half-written report.
// The previous result is moved aside first and restored if publishing fails.
export function publishCompletedDirectory(staging, finalDirectory) {
  const source = path.resolve(staging);
  const final = path.resolve(finalDirectory);
  const previous = `${final}.previous-${process.pid}`;
  const replacedPrevious = existsSync(final);
  if (!existsSync(source)) throw new Error(`Completed staging directory does not exist: ${source}`);
  rmSync(previous, { recursive: true, force: true });
  try {
    if (replacedPrevious) renameSync(final, previous);
    renameSync(source, final);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(final) && existsSync(previous)) renameSync(previous, final);
    throw error;
  }
  return { replacedPrevious };
}
