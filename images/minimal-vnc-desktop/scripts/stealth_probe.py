#!/usr/bin/env python3
"""Lightweight stealth probe battery for minimal-vnc-desktop.

Attaches to the RUNNING container's chromium over the FULL CDP proxy (9226)
and drives it directly, so it exercises the real image — not a mock. This is a
dependency-light alternative to ../stealth-tests (which needs node/playwright):
it uses only python3 + `websockets` and reads verdicts straight out of each
test page's DOM over CDP.

Probes:
  fingerprint  identity coherence + automation tells (webdriver/cdc/plugins/UA)
  sannysoft    bot.sannysoft.com — zero failed rows
  creepjs      CreepJS — reports the "lies" count (canvas/audio noise is expected)
  recaptcha    reCAPTCHA v3 score via Google's official backend demo (pass >= 0.7)
  cloudflare   nowsecure.nl (CF bot management) — content served, no challenge

Usage:
  python3 stealth_probe.py                          # all probes, as-is
  python3 stealth_probe.py --mobile                 # apply coherent mobile-touch profile first
  python3 stealth_probe.py fingerprint recaptcha    # a subset
  CDP_HOST=127.0.0.1:9226 python3 stealth_probe.py   # custom CDP endpoint

Requires the FULL CDP proxy (9226). The restricted proxy (9222) filters the
Runtime/Page commands the probes need.

  pip3 install websockets
"""

import json
import os
import sys
import time
import urllib.request

try:
    from websockets.sync.client import connect
except ImportError:
    sys.exit("missing dependency: pip3 install websockets")

CDP_HOST = os.environ.get("CDP_HOST", "127.0.0.1:9226")
GREEN, RED, YEL, DIM, RST = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


class CDP:
    """Minimal CDP client: attach to the page target, evaluate JS, navigate."""

    def __init__(self, host):
        ver = json.load(urllib.request.urlopen(f"http://{host}/json/version", timeout=5))
        targets = json.load(urllib.request.urlopen(f"http://{host}/json", timeout=5))
        page = next(
            (t for t in targets
             if t.get("type") == "page" and not (t.get("url") or "").startswith("devtools://")),
            None,
        )
        if not page:
            raise SystemExit("no page target — is chromium up?")
        self.ws = connect(ver["webSocketDebuggerUrl"], max_size=None, open_timeout=10)
        self._id = 0
        self.sid = self._attach(page["id"])

    def _send(self, method, params=None, sid=None):
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if sid:
            msg["sessionId"] = sid
        self.ws.send(json.dumps(msg))
        return self._id

    def _await(self, want):
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == want:
                return m

    def _attach(self, target_id):
        i = self._send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        r = self._await(i)
        return r["result"]["sessionId"]

    def call(self, method, params=None):
        i = self._send(method, params, self.sid)
        return self._await(i)

    def evaluate(self, expr, await_promise=False):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True, "awaitPromise": await_promise})
        if "error" in r:
            return None
        res = r.get("result", {}).get("result", {})
        return res.get("value", res.get("description"))

    def navigate(self, url, settle=8):
        self.call("Page.enable")
        self.call("Page.navigate", {"url": url})
        time.sleep(settle)

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def apply_mobile(cdp):
    """The coherent Windows-touch-device profile: a narrow viewport (mobile
    layout via width media queries) + touch, WITHOUT mobile:true (which desyncs
    the fingerprint). Applied before navigation so touch is present at load."""
    cdp.call("Emulation.setDeviceMetricsOverride", {
        "width": 390, "height": 780, "deviceScaleFactor": 1, "mobile": False,
        "screenWidth": 1920, "screenHeight": 1080,
    })
    cdp.call("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})


# ---- probes: each returns (verdict, detail); verdict in PASS/FAIL/INFO -------

def probe_fingerprint(cdp):
    ident = cdp.evaluate(r"""JSON.stringify({
      ua:navigator.userAgent, platform:navigator.platform, vendor:navigator.vendor,
      uaData:navigator.userAgentData?{mobile:navigator.userAgentData.mobile,platform:navigator.userAgentData.platform}:null,
      webdriver:navigator.webdriver, plugins:navigator.plugins.length, langs:navigator.languages,
      maxTouch:navigator.maxTouchPoints, onTouch:('ontouchstart' in window), coarse:matchMedia('(pointer:coarse)').matches,
      screen:screen.width+'x'+screen.height, inner:innerWidth+'x'+innerHeight,
      headlessUA:/Headless/i.test(navigator.userAgent),
      cdc:Object.keys(window).filter(function(k){return /cdc_|webdriver|selenium|nightmare|phantom|domAutomation/i.test(k)}),
      webgl:(function(){try{var c=document.createElement('canvas').getContext('webgl');var d=c.getExtension('WEBGL_debug_renderer_info');return c.getParameter(d.UNMASKED_RENDERER_WEBGL);}catch(e){return 'n/a'}})()
    })""")
    if not ident:
        return "FAIL", "could not read navigator"
    fp = json.loads(ident)
    tells = []
    if fp["webdriver"]:
        tells.append("navigator.webdriver=true")
    if fp["headlessUA"]:
        tells.append("HeadlessChrome in UA")
    if fp["plugins"] == 0:
        tells.append("0 plugins")
    if fp["cdc"]:
        tells.append("automation globals: " + ",".join(fp["cdc"]))
    # touch coherence: maxTouch>0 should imply ontouchstart
    if fp["maxTouch"] > 0 and not fp["onTouch"]:
        tells.append("maxTouchPoints>0 but no ontouchstart")
    # platform vs UA coherence
    ua_win = "Windows" in fp["ua"]
    plat_win = fp["platform"] in ("Win32", "Win64")
    if ua_win != plat_win:
        tells.append(f"UA/platform mismatch (ua_win={ua_win}, platform={fp['platform']})")
    detail = (f"{fp['platform']} | uaData={fp['uaData']} | touch(max={fp['maxTouch']},on={fp['onTouch']},"
              f"coarse={fp['coarse']}) | screen={fp['screen']} inner={fp['inner']} | webgl={fp['webgl']}")
    return ("PASS" if not tells else "FAIL"), detail + (("  TELLS: " + "; ".join(tells)) if tells else "")


def probe_sannysoft(cdp):
    cdp.navigate("https://bot.sannysoft.com", 7)
    bad = cdp.evaluate(r"""(function(){var out=[];document.querySelectorAll('table tr').forEach(function(r){var td=r.querySelectorAll('td');if(td.length>=2){var cls=td[1].className||'';if(/failed|present/i.test(cls))out.push(td[0].innerText.trim());}});return out.join(', ');})()""")
    return ("PASS" if not bad else "FAIL"), ("no failed rows" if not bad else "failed: " + bad)


def probe_creepjs(cdp):
    cdp.navigate("https://abrahamjuliot.github.io/creepjs/", 26)
    lies = cdp.evaluate("document.querySelectorAll('.lies, .rejected, .bad').length")
    types = cdp.evaluate(r"""JSON.stringify(Array.from(document.querySelectorAll('.lies, .rejected, .bad')).map(function(e){var t=(e.parentElement?e.parentElement.innerText:e.innerText);var m=t.match(/Canvas|Audio|DOMRect|Screen|Navigator|WebGL|TextMetrics|Timezone/i);return m?m[0]:'?';}))""")
    seen = sorted(set(json.loads(types or "[]")))
    # canvas/audio/domrect are Fortress anti-tracking noise, not identity spoofs
    only_noise = all(t in ("Canvas", "Audio", "DOMRect") for t in seen) if seen else True
    return ("INFO" if only_noise else "FAIL"), f"{lies} lie-entries; sources={seen or 'none'} ({'anti-tracking noise' if only_noise else 'includes identity lies'})"


def probe_recaptcha(cdp):
    cdp.navigate("https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php", 20)
    txt = cdp.evaluate(r"""(function(){
      var text = document.body ? document.body.innerText || '' : '';
      var json = text.match(/"score"\s*:\s*([0-9.]+)/);
      if (json) return json[1];
      var loose = text.match(/\bscore\b[^0-9]{0,40}([01](?:\.\d+)?)/i);
      return loose ? loose[1] : '';
    })()""")
    try:
        score = float(txt)
    except (TypeError, ValueError):
        return "INFO", "could not read score from official demo"
    return ("PASS" if score >= 0.7 else "FAIL"), f"reCAPTCHA v3 score = {score}"


def probe_cloudflare(cdp):
    cdp.navigate("https://nowsecure.nl", 14)
    v = cdp.evaluate(r"""(function(){var t=(document.title+' '+document.body.innerText).toLowerCase();if(/just a moment|checking your browser|attention required|verify you are human/.test(t))return 'CHALLENGE';if(/oh yeah|nowsecure/.test(t))return 'PASS';return 'UNKNOWN';})()""")
    return ("PASS" if v == "PASS" else "FAIL" if v == "CHALLENGE" else "INFO"), f"nowsecure.nl verdict: {v}"


PROBES = {
    "fingerprint": probe_fingerprint,
    "sannysoft": probe_sannysoft,
    "creepjs": probe_creepjs,
    "recaptcha": probe_recaptcha,
    "cloudflare": probe_cloudflare,
}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    mobile = "--mobile" in sys.argv[1:]
    wanted = args or list(PROBES)

    print(f"{DIM}CDP {CDP_HOST} | profile: {'mobile-touch (coherent Windows touch device)' if mobile else 'as-is'}{RST}\n")
    cdp = CDP(CDP_HOST)
    if mobile:
        apply_mobile(cdp)
        # `ontouchstart in window` is fixed at document creation, so reload a
        # fresh document AFTER enabling touch — otherwise the fingerprint probe
        # reads the pre-touch about:blank and reports a false "no ontouchstart".
        # The real image applies touch pre-navigation (Target.setAutoAttach), so
        # this just mirrors production; the Emulation overrides persist the reload.
        cdp.navigate("about:blank", settle=1)

    failed = False
    for name in wanted:
        fn = PROBES.get(name)
        if not fn:
            print(f"  unknown probe: {name} (have: {', '.join(PROBES)})")
            continue
        try:
            verdict, detail = fn(cdp)
        except Exception as e:  # noqa: BLE001
            verdict, detail = "ERROR", str(e)
        color = {"PASS": GREEN, "FAIL": RED, "ERROR": RED}.get(verdict, YEL)
        print(f"  {color}{verdict:5}{RST} {name:12} {DIM}{detail}{RST}")
        if verdict in ("FAIL", "ERROR"):
            failed = True

    cdp.close()
    print()
    print(f"{DIM}note: reCAPTCHA/Cloudflare weight egress IP reputation heavily; a low score there{RST}")
    print(f"{DIM}reflects the IP (use a residential proxy), not necessarily the fingerprint.{RST}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
