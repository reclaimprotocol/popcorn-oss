#!/usr/bin/env node
import { Browser, FingerprintLibrary, Profile } from '@proxyshard/shardx';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';

// Use the immutable build artifacts; never invoke the SDK auto-updater.
const root = '/opt/shard/runtime';
const emulatorOff = process.env.MVD_EMULATOR_OFF ?? '1';
if (!['0', '1'].includes(emulatorOff)) throw new Error('Invalid MVD_EMULATOR_OFF (valid: 0, 1)');
// run-chromium-managed selects the mode per pod; normal view gets its own profile.
const kiosk = (process.env.BROWSER_KIOSK ?? 'true') === 'true';
const manifest = JSON.parse(readFileSync('/opt/shard/runtime.json', 'utf8'));
const profilesRoot = process.env.SHARD_PROFILE_DIR || join(process.env.BROWSER_PROFILE_DIR || '/home/kernel/user-data', 'shard');
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

// Same startup page and policy variant selection as the main browser image.
const loadingPage = 'https://reclaim-portal-loading-page.s3.ap-south-1.amazonaws.com/index.html';
const replaceDefaultPage = process.env.REPLACE_DEFAULT_PAGE === 'true';
const startUrl = process.env.APP_URL || process.env.POPCORN_BROWSER_STARTUP_URL ||
  (replaceDefaultPage ? loadingPage : 'https://start.duckduckgo.com/');
if (replaceDefaultPage) {
  const policyDir = process.env.CHROMIUM_POLICY_DIR || '/etc/chromium/policies/managed';
  const variant = join(process.env.CHROMIUM_POLICY_VARIANT_DIR || '/etc/chromium/policy-variants', 'policy.reclaim-portal.json');
  if (existsSync(variant)) {
    mkdirSync(policyDir, { recursive: true });
    copyFileSync(variant, join(policyDir, 'policy.json'));
  } else {
    console.error(`[popcorn] REPLACE_DEFAULT_PAGE=true but ${variant} is missing; keeping default policy`);
  }
}

// A persona is frozen once per profile directory from a random real-device
// template. Its cores, memory and OS version are kept as sampled: the SDK's
// re-roll brackets the host's CPU count, which can pair a dual-core laptop GPU
// with 16 threads.
// WebGL renders through SwiftShader here, so the default pool is Intel
// integrated graphics, the most common Windows GPU and the most plausible one
// for software-rendered timings.
const saved = join(profilesRoot, 'popcorn-profile.json');
let profile;
if (existsSync(saved)) {
  const data = JSON.parse(readFileSync(saved, 'utf8'));
  profile = new Profile(data.config, data.id);
} else {
  const library = new FingerprintLibrary(runtime);
  const platform = process.env.SHARD_PLATFORM || 'Windows';
  let template = process.env.SHARD_TEMPLATE;
  if (!template) {
    const pattern = new RegExp(process.env.SHARD_TEMPLATE_PATTERN || '^win-(hd|uhd|iris|intel)');
    const ids = [...library.filter({ platform })].filter(id => pattern.test(id) && !library.load(id).claimsMobile);
    if (!ids.length) throw new Error(`No ShardBrowser templates for platform ${platform}`);
    template = ids[randomInt(ids.length)];
  }
  const id = randomUUID().replaceAll('-', '');
  profile = new Profile(library.load(template).config, id);
  // Templates carry their source machine's locale. "auto" resolves the
  // timezone from this pod's egress at first launch; the control plane
  // re-aligns it to the session proxy over CDP.
  profile.config.timezone = process.env.SHARD_TIMEZONE || 'auto';
  const language = process.env.SHARD_LANGUAGE || 'en-US';
  profile.config.navigator.language = language;
  profile.config.navigator.languages = [...new Set([language, language.split('-')[0], 'en-US', 'en'])];
  profile.config.navigator.accept_language = profile.config.navigator.languages
    .map((tag, i) => (i ? `${tag};q=${(1 - i / 10).toFixed(1)}` : tag)).join(',');
  profile.config.icu_locale = language;
  profile.config.geolocation = { mode: 'block' };
  console.log(`[popcorn] created ShardBrowser profile ${id} from ${template}`);
}
// A Windows desktop at 100% scale keeps a 40 px taskbar out of the available
// area; the kiosk window covers the whole display.
const width = Number(process.env.WIDTH || 1920);
const height = Number(process.env.HEIGHT || 1080);
const taskbar = profile.platform === 'Windows' ? 40 : 0;
Object.assign(profile.config.screen ??= {}, {
  width, height, avail_width: width, avail_height: height - taskbar,
  avail_left: 0, avail_top: 0, device_pixel_ratio: 1,
});
const port = Number(process.env.CDP_INTERNAL_PORT || 9223);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP_INTERNAL_PORT');
const extraArgs = [
  '--no-sandbox', '--disable-dev-shm-usage', '--no-default-browser-check',
  '--window-position=0,0', `--window-size=${width},${height}`,
  '--remote-debugging-address=127.0.0.1',
  // No GPU in the pod: SwiftShader keeps WebGL available; compositing stays on the CPU.
  '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader',
  '--disable-gpu-compositing', '--disable-gpu-rasterization',
];
if (kiosk) extraArgs.push('--kiosk');
else extraArgs.push('--start-maximized');
if (process.env.ENABLE_PROXY_EXTENSION !== 'false') {
  const extension = process.env.PROXY_EXTENSION_DIR || '/home/kernel/extensions/proxy';
  writeFileSync(join(extension, 'browser-mode.js'), `globalThis.POPCORN_BROWSER_KIOSK = ${kiosk};\n`);
  writeFileSync(join(extension, 'emulation-mode.js'), `globalThis.POPCORN_EMULATION_ENABLED = ${emulatorOff === '0'};\n`);
  extraArgs.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
}
extraArgs.push(startUrl);
// The noVNC/CDP proxy re-reads this marker; missing or invalid means kiosk.
writeFileSync(process.env.BROWSER_MODE_FILE || '/tmp/popcorn-browser-mode', kiosk ? 'kiosk\n' : 'normal\n');
const udd = join(profilesRoot, profile.id);
for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(udd, lock), { force: true });
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
    cdp: true, headless: false, screenMode: 'profile',
    quic: false, webrtc: 'block', extraArgs,
  });
  // Persist the resolved timezone so the identity stays stable across restarts.
  writeFileSync(saved, JSON.stringify({ id: profile.id, config: profile.config }), { mode: 0o600 });
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
  console.log(`[popcorn] ShardBrowser ${version.Browser} ready in ${kiosk ? 'kiosk' : 'normal'} mode on internal CDP port ${port}`);
  session.process.on('exit', code => { if (!stopping) process.exit(code || 1); });
  if (session.process.exitCode !== null) await stop(1);
} catch (error) {
  console.error(`[popcorn] ${error.message}`);
  await stop(1);
}
