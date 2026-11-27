import { readFileSync, writeFileSync } from 'node:fs';

// Chrome downloads a Hunspell dictionary for each spellcheck language the first
// time a page has an editable field. ShardBrowser restores the profile language
// to the spellcheck list, so block those languages in the managed policy.
export function blockSpellcheckLanguages(policyFile, languages) {
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('policy is not a JSON object');
  policy.SpellcheckLanguageBlocklist = [...new Set(languages)];
  writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
}
