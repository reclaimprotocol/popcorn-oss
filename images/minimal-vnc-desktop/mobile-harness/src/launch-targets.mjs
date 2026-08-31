import { shellQuote } from './shell-quote.mjs';

// Which app hosts the page. Defaults keep the historical behavior — Chrome on
// Android, Safari on iOS — so a scenario that names no target, or runs without
// an environment file, behaves exactly as it did.
export const defaultAndroidLaunchTarget = {
  name: 'chrome',
  label: 'Chrome',
  package: 'com.android.chrome',
  urlDelivery: 'view-intent',
  // A fresh emulator shows Chrome's first-run screen and then a notifications
  // promo, either of which hides the page before the case's ready marker can
  // appear. Flags cover first run; the promo has to be dismissed by node id.
  preparation: {
    commandLineFile: '/data/local/tmp/chrome-command-line',
    commandLineFlags: [
      '--disable-fre',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-experiments',
    ],
    debugApp: true,
    dismissNodeIds: ['com.android.chrome:id/negative_button'],
    dismissRounds: 3,
  },
};

export const defaultIosLaunchTarget = {
  name: 'safari',
  label: 'Safari',
  browserName: 'Safari',
  urlDelivery: 'open-url',
};

export function defaultLaunchTarget(platform) {
  return platform === 'Android' ? defaultAndroidLaunchTarget : defaultIosLaunchTarget;
}

export function androidIntentExtras(extras) {
  return Object.entries(extras ?? {}).map(([key, value]) => {
    if (typeof value === 'boolean') return `--ez ${shellQuote(key)} ${value}`;
    if (typeof value === 'number') return `--ei ${shellQuote(key)} ${Math.round(value)}`;
    return `--es ${shellQuote(key)} ${shellQuote(String(value))}`;
  }).join(' ');
}

// The whole command travels through the device shell as one string, so every
// value is quoted here: a LiveView URL carries & and ? in its query.
export function androidLaunchCommand(target, url) {
  if (!target?.package) throw new Error('Android launch target requires a package');
  if (!url) throw new Error('Android launch requires a url');
  const extras = androidIntentExtras(target.extras);
  if (target.urlDelivery === 'extra') {
    if (!target.activity) throw new Error(`Android launch target ${target.name} requires an activity for extra delivery`);
    return [
      'am start -W -a android.intent.action.VIEW',
      `-n ${shellQuote(`${target.package}/${target.activity}`)}`,
      `--es ${shellQuote(target.urlExtra ?? 'url')} ${shellQuote(url)}`,
      extras,
    ].filter(Boolean).join(' ');
  }
  // application_id makes Chrome REUSE the tab it last opened for this id instead of
  // stacking a new one. Without it every launch adds a tab — two per pair, ~90 over a
  // suite — and the emulator eventually cannot start another renderer: the run then
  // fails with a crashed-tab page and a marker that "never appeared", which reads
  // like a product fault and is really just tab exhaustion. A target may override it
  // through extras.
  const reuseTab = target.extras && 'com.android.browser.application_id' in target.extras
    ? ''
    : `--es ${shellQuote('com.android.browser.application_id')} ${shellQuote(target.package)}`;
  return [
    'am start -W -a android.intent.action.VIEW',
    `-p ${shellQuote(target.package)}`,
    `-d ${shellQuote(url)}`,
    reuseTab,
    extras,
  ].filter(Boolean).join(' ');
}

function iosLaunchArguments(extras) {
  return Object.entries(extras ?? {}).flatMap(([key, value]) => [`-${key}`, String(value)]);
}

// simctl takes an argv array, so nothing here is shell-quoted.
export function iosLaunchArgv(target, url, udid) {
  if (!udid) throw new Error('iOS launch requires a simulator udid');
  if (!url) throw new Error('iOS launch requires a url');
  const delivery = target?.urlDelivery ?? 'open-url';
  if (delivery === 'open-url') return ['simctl', 'openurl', udid, url];
  if (!target.bundleId) throw new Error(`iOS launch target ${target.name} requires a bundleId for ${delivery} delivery`);
  if (delivery === 'launch-args') {
    return [
      'simctl', 'launch', '--terminate-running-process', udid, target.bundleId,
      `-${target.urlArgument ?? 'url'}`, url,
      ...iosLaunchArguments(target.extras),
    ];
  }
  if (delivery === 'custom-scheme') {
    if (!target.scheme) throw new Error(`iOS launch target ${target.name} requires a scheme for custom-scheme delivery`);
    const launch = new URL(`${target.scheme}://open`);
    launch.searchParams.set(target.urlQuery ?? 'url', url);
    for (const [key, value] of Object.entries(target.extras ?? {})) {
      launch.searchParams.set(key, String(value));
    }
    return ['simctl', 'openurl', udid, launch.toString()];
  }
  throw new Error(`iOS launch target ${target.name} has unsupported urlDelivery ${delivery}`);
}
