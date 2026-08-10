#!/usr/bin/env bash
# Apply mobile-viewport emulation to the running chromium via CDP.
#
# Ports the CDP sequence from `applyViewportEmulation` in
# https://github.com/reclaimprotocol/popcorn-images/commit/bacfdb06 —
# the commit that originally introduced the magnify feature. Once the
# remote layout is mobile-sized, the popcorn client auto-applies its CSS
# crop based on the layout-viewport size it sees in the focus push, so the
# top-left screenW × screenH of the 1920×1080 framebuffer fills the screen.
#
# Key choices:
#   * deviceScaleFactor = 1 (DPR>1 makes chromium render at 2× and overflow
#     the stream, then clip — kills the crop)
#   * height is capped to the physical 1080 so the emulated viewport fits in
#     the framebuffer
#   * setUserAgentOverride: USER_AGENT is the UA chromium will report to
#     the loaded page. Defaults to Chrome-on-Android — overridable via env.
#     Note: this only changes navigator.userAgent on the REMOTE chromium.
#     It does NOT match the remote's TLS fingerprint to a mobile device
#     (that's still Linux chromium). Use a UA matching real devices when
#     bot detection compares the two; pick any plausible UA otherwise.
#
# Usage:
#   ./cdp-magnify.sh                     # default 390x844 with iPhone UA
#   ./cdp-magnify.sh 390 844
#   ./cdp-magnify.sh 390x844
#   ./cdp-magnify.sh 768x1024
#   USER_AGENT='...' ./cdp-magnify.sh 412x915     # override UA
#   ./cdp-magnify.sh reset                       # back to native 1920x1080
#
# Talks to the unfiltered internal devtools router on :9226. Make sure
# `-p 9226:9226` is in your `docker run` (run-docker.sh already exports it).
set -e -o pipefail

PHYSICAL_WIDTH=1920
PHYSICAL_HEIGHT=1080

WIDTH=390
HEIGHT=844
MODE=fit
# 127.0.0.1 (not localhost): on macOS localhost may resolve to IPv6 ::1 first
# while Docker publishes IPv4 only, giving intermittent connection failures.
CDP_HOST="${CDP_HOST:-127.0.0.1:9226}"

if [[ "$1" == "reset" ]]; then
  MODE=reset
elif [[ "$1" == *x* && "$1" != -* ]]; then
  WIDTH="${1%x*}"
  HEIGHT="${1#*x}"
  CDP_HOST="${2:-$CDP_HOST}"
elif [[ -n "$1" ]]; then
  WIDTH="$1"
  HEIGHT="${2:-844}"
  CDP_HOST="${3:-$CDP_HOST}"
fi

# Default UA: Chrome on Android, NOT iPhone Safari. The remote is a Chromium
# engine — an iPhone/Safari UA desyncs from the Sec-CH-UA* client-hint headers
# (Safari sends none; Chromium always sends them), from navigator.userAgentData,
# and from the TLS/JS-engine signature, which is a deterministic bot tell. A
# Chrome-on-Android UA keeps the engine, client hints, and TLS coherent. We also
# push a matching userAgentMetadata below so Sec-CH-UA / navigator.userAgentData
# move together with the string (a UA string alone is the classic desync leak).
#
# CAVEAT: the base is now Tilion Fortress (stable Chromium 149), which still
# presents a desktop Linux platform (navigator.platform / screen / WebGL / TLS).
# This override makes magnify a coherent *mobile viewport* experience; it is NOT
# a stealth-grade mobile spoof. Strict bot detection on a mobile-only target
# would also need the browser to spoof platform=android — out of scope here.
#
# Keep the Chrome major version aligned with the Fortress engine (149); a UA
# claiming a different major than the real engine is itself a desync tell.
DEFAULT_UA='Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36'
USER_AGENT="${USER_AGENT:-$DEFAULT_UA}"

for cmd in curl jq python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing: $cmd" >&2; exit 1
  fi
done

if ! curl -fsS --max-time 5 "http://${CDP_HOST}/json/version" >/dev/null 2>&1; then
  echo "cannot reach CDP at http://${CDP_HOST} — is the full endpoint published (-p 9226:9226) and reachable from here?" >&2
  exit 1
fi

PAGE_TARGET=$(curl -fsS "http://${CDP_HOST}/json" \
  | jq -r '.[] | select(.type == "page") | select((.url // "") | startswith("devtools://") | not) | .id' \
  | head -n1)
if [[ -z "$PAGE_TARGET" ]]; then
  echo "no page target at http://${CDP_HOST}/json" >&2; exit 1
fi

BROWSER_WS=$(curl -fsS "http://${CDP_HOST}/json/version" | jq -r '.webSocketDebuggerUrl // empty')
[[ -z "$BROWSER_WS" ]] && BROWSER_WS="ws://${CDP_HOST}/devtools/browser"

echo "==> $BROWSER_WS"
if [[ "$MODE" == "reset" ]]; then
  echo "    mode=reset  target=$PAGE_TARGET"
else
  echo "    mode=fit  ${WIDTH}x${HEIGHT}  target=$PAGE_TARGET"
fi

exec python3 - "$BROWSER_WS" "$PAGE_TARGET" "$WIDTH" "$HEIGHT" "$MODE" "$USER_AGENT" "$PHYSICAL_WIDTH" "$PHYSICAL_HEIGHT" <<'PY'
import json, sys
try:
    from websockets.sync.client import connect
except ImportError:
    sys.stderr.write("missing python websockets: pip3 install websockets\n"); sys.exit(1)

ws_url, target_id, w_raw, h_raw, mode, ua, phys_w_raw, phys_h_raw = sys.argv[1:]
phys_w, phys_h = int(phys_w_raw), int(phys_h_raw)

# Build userAgentMetadata that matches the UA string. Without this, only
# navigator.userAgent + the User-Agent header change while navigator.user-
# AgentData and the Sec-CH-UA* request headers keep reporting the unspoofed
# values — the UA/Client-Hints desync that Akamai/Cloudflare/CreepJS flag.
# We only know how to keep Chromium-based UAs coherent (Safari sends no client
# hints, so an iPhone UA can't be made consistent here anyway); for those we
# fall back to the string-only override.
def build_ua_metadata(ua_str):
    if "Chrome/" not in ua_str:
        return None  # non-Chromium UA: can't fake matching client hints
    try:
        full = ua_str.split("Chrome/", 1)[1].split(" ", 1)[0]   # e.g. 149.0.0.0
    except IndexError:
        full = "149.0.0.0"
    major = full.split(".", 1)[0]
    mobile = "Mobile" in ua_str or "Android" in ua_str
    if "Android" in ua_str:
        platform, platform_version, model = "Android", "13.0.0", "Pixel 7"
    elif "Windows" in ua_str:
        platform, platform_version, model = "Windows", "15.0.0", ""
    else:
        platform, platform_version, model = "Linux", "", ""
    brands = [
        {"brand": "Chromium", "version": major},
        {"brand": "Google Chrome", "version": major},
        {"brand": "Not)A;Brand", "version": "99"},
    ]
    full_list = [{"brand": b["brand"], "version": full} for b in brands]
    return {
        "brands": brands,
        "fullVersionList": full_list,
        "platform": platform,
        "platformVersion": platform_version,
        "architecture": "" if mobile else "x86",
        "model": model,
        "mobile": mobile,
    }

ua_metadata = build_ua_metadata(ua)
ua_override = {"userAgent": ua}
if ua_metadata is not None:
    ua_override["userAgentMetadata"] = ua_metadata

def send(ws, msg_id, method, session_id=None, **params):
    payload = {"id": msg_id, "method": method, "params": params}
    if session_id:
        payload["sessionId"] = session_id
    ws.send(json.dumps(payload))

def recv_id(ws, want_id):
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == want_id:
            return msg

with connect(ws_url, max_size=None) as ws:
    send(ws, 1, "Target.attachToTarget", targetId=target_id, flatten=True)
    res = recv_id(ws, 1)
    if "error" in res:
        sys.exit(f"attach failed: {res['error']}")
    session_id = res["result"]["sessionId"]

    # Cursor-hide is applied to the CURRENT document only, via Runtime.evaluate.
    # We deliberately do NOT use Page.addScriptToEvaluateOnNewDocument: its
    # returned identifier is scoped to the CDP *session* that added it, and
    # magnify/reset are separate CLI runs = separate sessions, so reset could
    # never remove it ("Script not found") and the cursor would stay hidden
    # forever. A current-document style survives SPA route changes (no new
    # document); it is dropped by a full page load, which is an acceptable
    # trade for a reset that always works. The <style> carries a stable id so
    # reset can find and remove it regardless of session.
    cursor_hide_js = "(()=>{if(document.getElementById('__popcorn_cursor_hide__'))return;var s=document.createElement('style');s.id='__popcorn_cursor_hide__';s.textContent='*,*::before,*::after{cursor:none!important;}';(document.head||document.documentElement).appendChild(s);})()"
    cursor_show_js = "(()=>{var s=document.getElementById('__popcorn_cursor_hide__');if(s)s.remove();})()"

    if mode == "reset":
        cmds = [
            ("Emulation.clearDeviceMetricsOverride", {}),
            # maxTouchPoints must be 1-16 even when disabling (0 is rejected).
            ("Emulation.setTouchEmulationEnabled", {"enabled": False, "maxTouchPoints": 1}),
            # NOTE: we deliberately do NOT setUserAgentOverride on reset.
            # Re-applying the mobile `ua` here would leave a mobile UA on a
            # reset-to-desktop viewport — exactly the kind of mismatch we're
            # avoiding. CDP can't "unset" an override without the original
            # string, and Fortress owns the native desktop UA, so the
            # least-bad move is to leave whatever is current untouched. If you
            # need a guaranteed-clean desktop UA after a magnify, restart the
            # page/target rather than reset.
            # Un-hide the cursor on the current document (session-independent).
            ("Runtime.evaluate", {"expression": cursor_show_js}),
        ]
    else:
        w, h = int(w_raw), min(int(h_raw), phys_h)
        # setDeviceMetricsOverride alone is enough — screenWidth/screenHeight
        # already constrain the rendered viewport. setVisibleSize is
        # deprecated in modern chromium and the client-side CSS crop
        # (auto-applied when the pushed viewportWidth shrinks below the
        # stream resolution) handles the framebuffer-vs-viewport gap.
        cmds = [
            ("Emulation.setDeviceMetricsOverride", {
                "width": w, "height": h,
                "deviceScaleFactor": 1,   # DPR>1 overflows the 1920x1080 stream
                "mobile": True,
                "screenWidth": w, "screenHeight": h,
            }),
            ("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5}),
            ("Emulation.setUserAgentOverride", ua_override),
            # Hide the desktop cursor on the current document. (Not persisted
            # across full navigations — see the cursor-hide note above.)
            ("Runtime.evaluate", {"expression": cursor_hide_js}),
        ]

    next_id = 2
    for method, params in cmds:
        send(ws, next_id, method, session_id=session_id, **params)
        res = recv_id(ws, next_id)
        if "error" in res:
            print(f"{method:48s} error: {res['error']}", file=sys.stderr)
        else:
            print(f"{method:48s} ok")
        next_id += 1
PY
