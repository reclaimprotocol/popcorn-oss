import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const compositing of [undefined, 'software', 'swiftshader', 'invalid']) {
for (const repair of ['true', 'false']) {
for (const persona of [undefined, 'windows', 'linux']) {
  test(`launcher reaches Chromium with repair ${repair}, compositing ${compositing ?? 'default'}, persona ${persona ?? 'default'}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'popcorn-launcher-'));
    try {
      const binary = join(dir, 'chromium');
      writeFileSync(binary, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
      chmodSync(binary, 0o755);
      const launcher = join(dir, 'launcher');
      // Exercise the full launcher with a capture binary instead of Chromium.
      writeFileSync(launcher, readFileSync(join(import.meta.dir, 'start-chromium'), 'utf8').replaceAll('/opt/tilion/tilion', binary).replaceAll('/etc/timezone', join(dir, 'timezone')).replaceAll('/etc/localtime', join(dir, 'localtime')));
      const result = Bun.spawnSync(['bash', launcher], {
        env: { ...process.env, BROWSER: 'fortress', POST_PROOF_LOGIN_REPAIR_ENABLED: repair,
          BROWSER_PROFILE_DIR: join(dir, 'profile'), BROWSER_MODE_FILE: join(dir, 'mode'),
          REPLACE_DEFAULT_PAGE: 'false', ENABLE_PROXY_EXTENSION: 'false', CLOAK_GEOIP: 'false',
          CLOAK_TIMEZONE: 'Etc/UTC', CLOAK_LOCALE: 'en-US', CLOAK_FINGERPRINT_SEED: '1234567',
          APP_URL: '', POPCORN_BROWSER_STARTUP_URL: '', CHROMIUM_STARTUP_URL: '', CHROMIUM_FLAGS: '',
          FORTRESS_COMPOSITING: compositing, PERSONA: persona },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (compositing === 'invalid') {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain('invalid FORTRESS_COMPOSITING');
        expect(result.stdout.toString()).not.toContain('--remote-debugging-port=');
        return;
      }
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const lines = result.stdout.toString().trim().split('\n');
      expect(result.stdout.toString()).toContain(`persona=${persona ?? 'windows'}`);
      for (const flag of ['--uxr-platform=Linux x86_64', '--uxr-ua-platform=Linux',
        '--uxr-ua-os=X11; Linux x86_64']) {
        expect(lines.filter(line => line === flag)).toHaveLength(persona === 'linux' ? 1 : 0);
      }
      for (const flag of ['--use-angle=swiftshader-webgl', '--disable-gpu-compositing',
        '--disable-gpu-rasterization', '--enable-unsafe-swiftshader']) {
        expect(lines.filter(line => line === flag)).toHaveLength(compositing === 'swiftshader' ? 0 : 1);
      }
      expect(lines.filter(line => line === '--disable-component-extensions-with-background-pages')).toHaveLength(repair === 'true' ? 1 : 0);
      expect(lines.at(-1)).toBe(repair === 'true' ? 'about:blank' : 'https://start.duckduckgo.com/');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
}
}
