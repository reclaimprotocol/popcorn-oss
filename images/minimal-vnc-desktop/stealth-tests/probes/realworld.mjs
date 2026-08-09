// Real-world canaries. These are not deterministic fingerprint unit tests:
// live sites change markup, deploy new rules, and weight IP reputation heavily.
// The value is in quickly seeing which production surfaces render normally,
// which ones challenge, and which anti-bot stack/cookies are involved.

import { connect, humanize, section, summary } from '../utils.mjs';

const DEFAULT_TIMEOUT = Number(process.env.REALWORLD_TIMEOUT_MS || 45000);
const TEXT_MIN = Number(process.env.REALWORLD_TEXT_MIN || 300);

const TARGETS = [
  {
    name: 'google-account',
    url: 'https://accounts.google.com/signin/v2/identifier?service=mail',
    expect: ['input[type="email"]', 'input[type="text"]', '#identifierId'],
    host: 'https://accounts.google.com/',
  },
  {
    name: 'microsoft-login',
    url: 'https://login.live.com/',
    expect: ['input[type="email"]', 'input[name="loginfmt"]'],
    host: 'https://login.live.com/',
  },
  {
    name: 'github-login',
    url: 'https://github.com/login',
    expect: ['input[name="login"]', 'input[name="password"]'],
    host: 'https://github.com/',
  },
  {
    name: 'amazon-signin',
    url: 'https://www.amazon.com/ap/signin',
    expect: ['input[name="email"]', '#ap_email'],
    host: 'https://www.amazon.com/',
  },
  {
    name: 'paypal-signin',
    url: 'https://www.paypal.com/signin',
    expect: ['input[name="login_email"]', '#email'],
    host: 'https://www.paypal.com/',
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/',
    expect: ['ytd-app', 'input#search'],
    host: 'https://www.youtube.com/',
  },
  {
    name: 'popcorn-rc',
    url: 'https://rc-popcorn.uc.r.appspot.com/',
    expect: ['#root', '#app', 'main', 'form', 'input', 'button'],
    host: 'https://rc-popcorn.uc.r.appspot.com/',
    allowBlock: ['captcha'],
    allowCaptcha: true,
  },
  {
    name: 'google-search',
    url: 'https://www.google.com/search?q=weather',
    expect: ['form[action="/search"]', '#search', 'textarea[name="q"]'],
    host: 'https://www.google.com/',
  },
  {
    name: 'walmart-search',
    url: 'https://www.walmart.com/search?q=laptop',
    expect: ['input[type="search"]', '[data-testid="item-stack"]', '[data-testid="list-view"]'],
    host: 'https://www.walmart.com/',
  },
];

const BLOCK_PATTERNS = [
  ['access denied', /access denied|you don't have permission|request blocked/i],
  ['captcha', /captcha|verify you are human|are you a robot|unusual traffic|automated queries/i],
  ['cloudflare challenge', /just a moment|checking if the site connection is secure|cf_chl_|challenge-form/i],
  ['perimeterx', /pardon the interruption|browsing activity has been paused|px-captcha/i],
  ['datadome', /datadome|please enable js and disable any ad blocker/i],
  ['imperva', /incapsula incident id|visid_incap|request unsuccessful/i],
  ['akamai deny', /reference #\d+|akamai|_abck/i],
];

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  '.g-recaptcha',
  '.h-captcha',
  '[data-sitekey]',
  '#px-captcha',
  '[id^="px-captcha"]',
];

const REPORT_COOKIES = [
  '_abck', 'bm_sz', 'ak_bmsc',
  '_px3', '_pxvid', '_pxhd', '_pxde',
  'datadome',
  'incap_ses', 'visid_incap',
  'cf_clearance', '__cf_bm',
];

function firstMatch(text) {
  for (const [name, re] of BLOCK_PATTERNS) {
    if (re.test(text)) return name;
  }
  return '';
}

function rowVerdict({ status, textLen, block, captcha, expected }) {
  const statusOk = status >= 200 && status < 400;
  const rendered = textLen >= TEXT_MIN;
  if (block || captcha) return { pass: false, warn: true, label: block || 'captcha' };
  if (!statusOk) return { pass: false, warn: true, label: `inconclusive http=${status} text=${textLen}` };
  if (expected) return { pass: true, warn: false, label: 'served expected surface' };
  if (!rendered) return { pass: false, warn: true, label: `inconclusive http=${status} text=${textLen}` };
  return { pass: false, warn: true, label: 'served but expected marker missing' };
}

export async function run({ closeBrowser = true, proxyAuth = false } = {}) {
  const { browser, ctx, page } = await connect({ proxyAuth });
  section('real-world production canaries');

  const rows = [];
  for (const target of TARGETS) {
    let status = 0;
    let navError = '';
    try {
      const resp = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
      status = resp?.status() || 0;
    } catch (e) {
      navError = e.message;
    }

    await humanize(page, { rounds: 2, dwell: 1000 });
    await page.waitForTimeout(2500);

    const probe = await page.evaluate(({ expect, captchaSelectors }) => {
      const text = document.body?.innerText || '';
      const html = document.documentElement?.outerHTML || '';
      const expected = expect.some((sel) => !!document.querySelector(sel));
      const captcha = captchaSelectors.some((sel) => !!document.querySelector(sel));
      const inputs = Array.from(document.querySelectorAll('input'))
        .map((el) => el.type || el.name || 'input')
        .filter(Boolean)
        .slice(0, 10);
      return {
        url: location.href,
        title: document.title || '',
        text: text.slice(0, 12000),
        textLen: text.length,
        htmlHead: html.slice(0, 4000),
        expected,
        captcha,
        inputs,
      };
    }, { expect: target.expect, captchaSelectors: CAPTCHA_SELECTORS }).catch((e) => ({
      url: '',
      title: '',
      text: '',
      textLen: 0,
      htmlHead: '',
      expected: false,
      captcha: false,
      inputs: [],
      error: e.message,
    }));

    const hay = `${probe.title}\n${probe.text}\n${probe.htmlHead}`;
    const block = firstMatch(hay);
    const allowedBlock = block && target.allowBlock?.includes(block);
    const effectiveBlock = allowedBlock ? '' : block;
    const effectiveCaptcha = target.allowCaptcha ? false : probe.captcha;
    const cookies = await ctx.cookies(target.host).catch(() => []);
    const seenCookies = REPORT_COOKIES.filter((name) => cookies.some((c) => c.name === name));
    const verdict = rowVerdict({ status, textLen: probe.textLen, block: effectiveBlock, captcha: effectiveCaptcha, expected: probe.expected });

    const detailBits = [
      `http=${status}`,
      `text=${probe.textLen}`,
      probe.expected ? 'expected=yes' : 'expected=no',
      effectiveCaptcha ? 'captcha=yes' : '',
      effectiveBlock ? `block=${effectiveBlock}` : '',
      allowedBlock ? `allowed=${block}` : '',
      seenCookies.length ? `cookies=${seenCookies.join('/')}` : '',
      navError ? `nav=${navError.slice(0, 80)}` : '',
    ].filter(Boolean);

    console.log(`  ${(verdict.pass ? '✓' : '!')} ${target.name.padEnd(18)} ${detailBits.join('  ')}  title="${probe.title.slice(0, 48)}"`);
    if (!verdict.pass && probe.url) console.log(`    url: ${probe.url.slice(0, 140)}`);
    if (!verdict.pass && probe.inputs.length) console.log(`    inputs: ${probe.inputs.join(',')}`);

    rows.push({
      name: `real ${target.name}`,
      pass: verdict.pass,
      warn: verdict.warn,
      detail: `${verdict.label}; ${detailBits.join(', ')}`,
    });
  }

  if (closeBrowser) await browser.close();
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run({ proxyAuth: process.env.PROXY_AUTH === '1' });
  summary(rows);
}
