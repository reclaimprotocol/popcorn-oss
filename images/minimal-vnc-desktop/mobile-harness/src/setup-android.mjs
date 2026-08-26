import { spawnSync } from 'node:child_process';

const version = spawnSync('adb', ['version'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.error('Android setup requires adb on PATH');
  process.exit(1);
}
console.log(version.stdout.trim());
console.log('Android uses framebuffer screenshots and native touch through ADB; no WebDriver driver is installed.');
