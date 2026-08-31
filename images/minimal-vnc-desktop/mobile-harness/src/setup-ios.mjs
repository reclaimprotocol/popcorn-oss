import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appiumHome = path.join(root, '.appium');
mkdirSync(appiumHome, { recursive: true });

const env = { ...process.env, APPIUM_HOME: appiumHome };
const appium = path.join(root, 'node_modules', '.bin', 'appium');
const list = spawnSync(appium, ['driver', 'list', '--installed', '--json'], {
  cwd: root,
  env,
  encoding: 'utf8',
});

console.log('Web-view cases additionally need the shell app: ./ios/webview-shell/build.sh');

if (list.status === 0 && /"xcuitest"/.test(list.stdout)) {
  console.log(`XCUITest driver already installed in ${appiumHome}`);
  process.exit(0);
}

const install = spawnSync(
  appium,
  ['driver', 'install', '--source=npm', 'appium-xcuitest-driver@12.5.0'],
  { cwd: root, env, stdio: 'inherit' },
);
process.exit(install.status ?? 1);
