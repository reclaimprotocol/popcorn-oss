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
// Post-proof login repair observes the provider from a clean checkpoint.
const loginRepair = process.env.POST_PROOF_LOGIN_REPAIR_ENABLED === 'true';
const startUrl = process.env.APP_URL || (loginRepair && 'about:blank') || process.env.POPCORN_BROWSER_STARTUP_URL ||
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
  // timezone from this pod's egress; a session proxy replaces it below.
  profile.config.timezone = process.env.SHARD_TIMEZONE || 'auto';
  const language = process.env.SHARD_LANGUAGE || 'en-US';
  profile.config.navigator.language = language;
  profile.config.navigator.languages = [...new Set([language, language.split('-')[0], 'en-US', 'en'])];
  profile.config.navigator.accept_language = profile.config.navigator.languages
    .map((tag, i) => (i ? `${tag};q=${(1 - i / 10).toFixed(1)}` : tag)).join(',');
  profile.config.icu_locale = language;
  profile.config.geolocation = { mode: 'block' };
  // Every pod renders through the same SwiftShader build, so without noise the
  // whole fleet shares one canvas, WebGL and audio hash. Seeds derive from the
  // profile id, so one profile stays stable across restarts.
  const noise = (process.env.SHARD_NOISE ?? 'canvas,webgl,audio,client_rects').split(',').map(v => v.trim()).filter(v => v && v !== 'none');
  profile.setNoise(...noise);
  console.log(`[popcorn] created ShardBrowser profile ${id} from ${template}`);
}
// Enabled noise needs a strength: a template's zero knob leaves the vector
// switched on but inert.
const noiseConfig = profile.config.noise ?? {};
if (noiseConfig.webgl?.enabled && !noiseConfig.webgl.intensity) noiseConfig.webgl.intensity = 0.0005;
if (noiseConfig.client_rects?.enabled && !noiseConfig.client_rects.max_offset) noiseConfig.client_rects.max_offset = 1;
// The template lists its source GPU's extensions. SwiftShader cannot provide
// these, so getExtension() would return null for advertised names, which
// detectors read as tampering.
const unavailableExtensions = new Set([
  'EXT_disjoint_timer_query', 'EXT_disjoint_timer_query_webgl2', 'EXT_render_snorm', 'EXT_texture_norm16',
  'KHR_parallel_shader_compile', 'WEBGL_blend_func_extended', 'WEBGL_provoking_vertex',
]);
for (const key of ['extensions', 'extensions_v2']) {
  if (Array.isArray(profile.config.webgl?.[key])) {
    profile.config.webgl[key] = profile.config.webgl[key].filter(name => !unavailableExtensions.has(name));
  }
}
// run-chromium-managed restarts the browser with the proxy exit's timezone
// when a session asks for a proxy; the pool keeps the profile's own.
if (process.env.BROWSER_TIMEZONE) profile.config.timezone = process.env.BROWSER_TIMEZONE;
// A Windows desktop at 100% scale keeps a 40 px taskbar out of the available
// area. The viewer proxy fits the window to the whole X screen in both modes,
// so the window block says so too; templates carry their source device's
// window, which would not fit this screen.
const width = Number(process.env.WIDTH || 1920);
const height = Number(process.env.HEIGHT || 1080);
const taskbar = profile.platform === 'Windows' ? 40 : 0;
Object.assign(profile.config.screen ??= {}, {
  width, height, avail_width: width, avail_height: height - taskbar,
  avail_left: 0, avail_top: 0, device_pixel_ratio: 1,
});
profile.config.window = {
  ...profile.config.window,
  outer_width: width, outer_height: height,
  inner_width: width, inner_height: kiosk ? height : height - 91,
};
const port = Number(process.env.CDP_INTERNAL_PORT || 9223);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP_INTERNAL_PORT');
const extraArgs = [
  '--no-sandbox', '--disable-dev-shm-usage', '--no-default-browser-check',
  '--window-position=0,0', `--window-size=${width},${height}`,
  '--remote-debugging-address=127.0.0.1',
  // No GPU in the pod: SwiftShader keeps WebGL available; compositing stays on the CPU.
  '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader',
  '--disable-gpu-compositing', '--disable-gpu-rasterization',
  // As in the main image: popup-based OAuth and payment flows need window.open.
  '--disable-popup-blocking',
];
if (loginRepair) extraArgs.push('--disable-component-extensions-with-background-pages');
if (kiosk) extraArgs.push('--kiosk');
else extraArgs.push('--start-maximized');
if (process.env.ENABLE_PROXY_EXTENSION !== 'false') {
  const extension = process.env.PROXY_EXTENSION_DIR || '/home/kernel/extensions/proxy';
  writeFileSync(join(extension, 'browser-mode.js'), `globalThis.POPCORN_BROWSER_KIOSK = ${kiosk};\n`);
  writeFileSync(join(extension, 'emulation-mode.js'), `globalThis.POPCORN_EMULATION_ENABLED = ${emulatorOff === '0'};\n`);
  extraArgs.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
}
extraArgs.push(...(process.env.CHROMIUM_FLAGS || '').split(/\s+/).filter(Boolean));
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
