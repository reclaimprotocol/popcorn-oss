import { Browser, FingerprintLibrary, Profile } from '@proxyshard/shardx';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';

// Use the immutable build artifacts; never invoke the SDK auto-updater.
const root = '/opt/shard/runtime';
const emulatorOff = process.env.MVD_EMULATOR_OFF ?? '1';
if (!['0', '1'].includes(emulatorOff)) throw new Error('Invalid MVD_EMULATOR_OFF (valid: 0, 1)');
const manifest = JSON.parse(readFileSync('/opt/shard/runtime.json', 'utf8'));
const profilesRoot = process.env.SHARD_PROFILE_DIR || '/home/kernel/user-data/shard';
mkdirSync(profilesRoot, { recursive: true });
const runtime = {
  root, profilesRoot,
  binaryPath: join(root, 'ShardX-Linux/chrome'),
  fingerprintsDir: join(root, 'fingerprints'),
  chromiumVersion: manifest.chromium_version,
  greaseBrand: manifest.grease_brand,
  greaseVersion: manifest.grease_version,
  tls: manifest.tls,
  install: async () => {},
};
const saved = join(profilesRoot, 'popcorn-profile.json');
let profile;
if (existsSync(saved)) {
  const data = JSON.parse(readFileSync(saved, 'utf8'));
  profile = new Profile(data.config, data.id);
} else {
  const template = new FingerprintLibrary(runtime).load(process.env.SHARD_TEMPLATE || 'win-rtx4060');
  profile = new Profile(template.config, randomUUID().replaceAll('-', ''));
  writeFileSync(saved, JSON.stringify({ id: profile.id, config: profile.config }), { mode: 0o600 });
}
// Explicit locale avoids the SDK's automatic geo lookup and direct fallback.
profile.config.timezone = process.env.SHARD_TIMEZONE || 'Etc/UTC';
profile.config.navigator.language = process.env.SHARD_LANGUAGE || 'en-US';
profile.config.navigator.languages = [profile.config.navigator.language, profile.config.navigator.language.split('-')[0]];
profile.config.navigator.accept_language = profile.config.navigator.languages.join(',');
profile.config.icu_locale = profile.config.navigator.language;
profile.config.geolocation = { mode: 'block' };
const port = Number(process.env.CDP_INTERNAL_PORT || 9223);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP_INTERNAL_PORT');
const extraArgs = [
  '--no-sandbox', '--disable-dev-shm-usage', '--kiosk', '--no-default-browser-check',
  '--window-position=0,0', `--window-size=${process.env.WIDTH || 1920},${process.env.HEIGHT || 1080}`,
  '--remote-debugging-address=127.0.0.1',
];
if (process.env.ENABLE_PROXY_EXTENSION !== 'false') {
  const extension = '/home/kernel/extensions/proxy';
  writeFileSync(join(extension, 'browser-mode.js'), 'globalThis.POPCORN_BROWSER_KIOSK = true;\n');
  writeFileSync(join(extension, 'emulation-mode.js'), `globalThis.POPCORN_EMULATION_ENABLED = ${emulatorOff === '0'};\n`);
  extraArgs.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
}
extraArgs.push('about:blank');
writeFileSync('/tmp/popcorn-browser-mode', 'kiosk\n');
const browser = new Browser(runtime);
let session;
let bridge;
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  bridge?.close();
  if (session) await session.stop();
  process.exit(code);
}
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
try {
  session = await browser.launch(profile, {
    cdp: true, headless: false, screenMode: 'use_host',
    quic: false, webrtc: 'block', extraArgs,
  });
  if (!session.cdpUrl) throw new Error('ShardBrowser did not expose CDP within 15 seconds');
  const upstream = new URL(session.cdpUrl);
  const response = await fetch(`http://127.0.0.1:${upstream.port}/json/version`);
  const version = await response.json();
  if (!response.ok || !version.Browser?.endsWith('/' + manifest.chromium_version)) {
    throw new Error('ShardBrowser engine version does not match pinned runtime');
  }
  // The SDK chooses an ephemeral debug port. Keep Popcorn's upstream fixed.
  bridge = createServer(client => {
    const target = connect(Number(upstream.port), '127.0.0.1');
    client.on('error', () => target.destroy());
    target.on('error', () => client.destroy());
    client.on('close', () => target.destroy());
    target.on('close', () => client.destroy());
    client.pipe(target).pipe(client);
  });
  await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(port, '127.0.0.1', resolve);
  });
  console.log(`[popcorn] ShardBrowser ${version.Browser} ready on internal CDP port ${port}`);
  session.process.on('exit', code => { if (!stopping) process.exit(code || 1); });
  if (session.process.exitCode !== null) await stop(1);
} catch (error) {
  console.error(`[popcorn] ${error.message}`);
  await stop(1);
}
