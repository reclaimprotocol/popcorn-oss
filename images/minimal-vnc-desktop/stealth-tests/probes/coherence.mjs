// Local browser-coherence probe. This catches first-party fingerprint
// contradictions before we spend minutes on external sites.

import { connect, section, summary } from '../utils.mjs';

function passRow(rows, name, pass, detail) {
  rows.push({ name, pass, detail });
  const mark = pass ? '✓' : '✗';
  console.log(`  ${mark} ${name.padEnd(32)} ${detail || ''}`);
}

export async function run({ closeBrowser = true } = {}) {
  const { browser, ctx } = await connect();
  const page = await ctx.newPage();
  section('local fingerprint coherence');

  await page.goto(`https://example.com/?coherence=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(1000);

  const data = await page.evaluate(async () => {
    const readWindow = (w) => ({
      inner: [w.innerWidth, w.innerHeight],
      outer: [w.outerWidth, w.outerHeight],
      screen: [w.screen.width, w.screen.height],
      avail: [w.screen.availWidth, w.screen.availHeight],
      dpr: w.devicePixelRatio,
    });
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      pcn: !!window.__pcn,
      webdriver: navigator.webdriver,
      suspiciousGlobals: Object.keys(window).filter((k) => /cdc_|webdriver|selenium|nightmare|phantom|domAutomation/i.test(k)),
      ua: navigator.userAgent,
      platform: navigator.platform,
      uaData: navigator.userAgentData ? {
        platform: navigator.userAgentData.platform,
        mobile: navigator.userAgentData.mobile,
        brands: navigator.userAgentData.brands,
      } : null,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      pointerFine: matchMedia('(pointer: fine)').matches,
      anyPointerFine: matchMedia('(any-pointer: fine)').matches,
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
      hoverHover: matchMedia('(hover: hover)').matches,
      anyHoverHover: matchMedia('(any-hover: hover)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      displayBrowser: matchMedia('(display-mode: browser)').matches,
      displayFullscreen: matchMedia('(display-mode: fullscreen)').matches,
      win: readWindow(window),
      frame: readWindow(frame.contentWindow),
      notificationPermission: window.Notification ? Notification.permission : 'missing',
      notificationQuery: navigator.permissions
        ? await navigator.permissions.query({ name: 'notifications' }).then((r) => r.state).catch((e) => `error:${e.name}`)
        : 'missing',
      share: 'share' in navigator,
      canShare: 'canShare' in navigator,
      downlinkMax: navigator.connection ? navigator.connection.downlinkMax : undefined,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      plugins: Array.from(navigator.plugins).map((p) => p.name),
      mimeTypes: Array.from(navigator.mimeTypes).map((m) => m.type),
      chromeKeys: window.chrome ? Object.keys(window.chrome).sort() : [],
      webglVendor: gl && dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '',
      webglRenderer: gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '',
    };
  });

  const rows = [];
  passRow(rows, 'extension injected', data.pcn, data.pcn ? '__pcn present' : '__pcn missing');
  passRow(rows, 'webdriver absent', data.webdriver === false, `navigator.webdriver=${data.webdriver}`);
  passRow(rows, 'automation globals absent', data.suspiciousGlobals.length === 0, data.suspiciousGlobals.join(',') || 'none');
  passRow(rows, 'windows persona coherent',
    /Windows NT/.test(data.ua) && data.platform === 'Win32' && data.uaData?.platform === 'Windows' && data.uaData?.mobile === false,
    `${data.platform}; uaData=${JSON.stringify(data.uaData)}`);
  passRow(rows, 'desktop input coherent',
    data.maxTouchPoints === 0 && data.pointerFine && data.anyPointerFine && !data.pointerCoarse && data.hoverHover && data.anyHoverHover && !data.hoverNone,
    `touch=${data.maxTouchPoints} fine=${data.pointerFine}/${data.anyPointerFine} hover=${data.hoverHover}/${data.anyHoverHover}`);
  passRow(rows, 'browser display mode',
    data.displayBrowser && !data.displayFullscreen,
    `browser=${data.displayBrowser} fullscreen=${data.displayFullscreen}`);
  passRow(rows, 'top screen metrics',
    JSON.stringify(data.win.screen) === '[1920,1080]' &&
      JSON.stringify(data.win.avail) === '[1920,1080]' &&
      data.win.dpr === 1,
    `screen=${data.win.screen.join('x')} avail=${data.win.avail.join('x')} dpr=${data.win.dpr}`);
  passRow(rows, 'blank-frame metrics',
    JSON.stringify(data.frame.screen) === '[1920,1080]' &&
      JSON.stringify(data.frame.avail) === '[1920,1080]' &&
      data.frame.dpr === 1 &&
      data.frame.outer[0] === data.frame.inner[0] &&
      data.frame.outer[1] === data.frame.inner[1],
    `inner=${data.frame.inner.join('x')} outer=${data.frame.outer.join('x')} avail=${data.frame.avail.join('x')} dpr=${data.frame.dpr}`);
  passRow(rows, 'intel webgl persona',
    /Intel/.test(data.webglVendor) && /Intel\(R\) UHD Graphics 630/.test(data.webglRenderer),
    `${data.webglVendor} | ${data.webglRenderer}`);
  passRow(rows, 'no swiftshader exposure',
    !/swiftshader/i.test(`${data.webglVendor} ${data.webglRenderer}`),
    `${data.webglVendor} | ${data.webglRenderer}`);
  passRow(rows, 'notification coherent',
    data.notificationPermission === 'default' && data.notificationQuery === 'prompt',
    `permission=${data.notificationPermission} query=${data.notificationQuery}`);
  passRow(rows, 'desktop api surface',
    data.share && data.canShare && data.downlinkMax === 10 && data.pdfViewerEnabled === true,
    `share=${data.share} canShare=${data.canShare} downlinkMax=${data.downlinkMax} pdf=${data.pdfViewerEnabled}`);
  passRow(rows, 'plugins/mime present',
    data.plugins.length >= 3 && data.mimeTypes.includes('application/pdf'),
    `plugins=${data.plugins.length} mime=${data.mimeTypes.join(',')}`);

  if (closeBrowser) await browser.close();
  return [{
    name: 'local coherence',
    pass: rows.every((r) => r.pass),
    detail: `${rows.filter((r) => r.pass).length}/${rows.length} checks`,
  }];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  summary(rows);
}
