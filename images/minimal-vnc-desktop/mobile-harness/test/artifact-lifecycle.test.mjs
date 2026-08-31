import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  publishCompletedDirectory,
  removeStaleStagingDirectories,
  stagingDirectory,
} from '../src/artifact-lifecycle.mjs';

test('completed case atomically replaces its previous directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'popcorn-artifact-lifecycle-'));
  const final = path.join(root, 'viewport-case');
  const staging = stagingDirectory(final, 'test');
  mkdirSync(final);
  mkdirSync(staging);
  writeFileSync(path.join(final, 'old.txt'), 'old');
  writeFileSync(path.join(staging, 'pair.json'), '{"status":"COMPLETE"}');

  const result = publishCompletedDirectory(staging, final);

  assert.equal(result.replacedPrevious, true);
  assert.equal(existsSync(path.join(final, 'old.txt')), false);
  assert.equal(readFileSync(path.join(final, 'pair.json'), 'utf8'), '{"status":"COMPLETE"}');
  assert.equal(existsSync(staging), false);
});

test('stale staging directories are removed without touching the published case', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'popcorn-artifact-staging-'));
  const final = path.join(root, 'viewport-case');
  const staleA = stagingDirectory(final, 'a');
  const staleB = stagingDirectory(final, 'b');
  mkdirSync(final);
  mkdirSync(staleA);
  mkdirSync(staleB);

  const removed = removeStaleStagingDirectories(final);

  assert.deepEqual(removed, [staleA, staleB]);
  assert.equal(existsSync(final), true);
  assert.equal(existsSync(staleA), false);
  assert.equal(existsSync(staleB), false);
});
