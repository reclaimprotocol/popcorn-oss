import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockSpellcheckLanguages } from './policy.mjs';

test('blockSpellcheckLanguages sets the blocklist and keeps other policies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-policy-'));
  try {
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{"PasswordManagerEnabled":false,"SpellcheckLanguageBlocklist":["fr"]}');
    blockSpellcheckLanguages(file, ['hi-IN', 'hi', 'en-US', 'en', 'en-US']);
    const policy = JSON.parse(readFileSync(file, 'utf8'));
    expect(policy.SpellcheckLanguageBlocklist).toEqual(['hi-IN', 'hi', 'en-US', 'en']);
    expect(policy.PasswordManagerEnabled).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('blockSpellcheckLanguages leaves an unparsable policy untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-policy-'));
  try {
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{not json');
    expect(() => blockSpellcheckLanguages(file, ['en-US'])).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
