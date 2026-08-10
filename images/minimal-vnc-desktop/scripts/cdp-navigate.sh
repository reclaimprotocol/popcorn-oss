#!/usr/bin/env bash
# Navigate the running container's kiosk Chromium to a URL via CDP — no restart,
# no address bar needed.
#
# Usage:   ./cdp-navigate.sh <url> [host:port]
# Example: ./cdp-navigate.sh https://www.kaggle.com/account/login
#          ./cdp-navigate.sh https://example.com 127.0.0.1:9226
#
# Defaults to 127.0.0.1:9226 — the FULL (unfiltered) devtools endpoint. The
# restricted proxy on :9222 has an allowlist that permits only Page.enable /
# Page.reload (not Page.navigate), so navigation must use :9226. Publish it
# first:  docker run ... -p 9226:9226 ...   (it binds 0.0.0.0:9226 in-container).
#
# The devtools proxy ignores the WS request path and always hands back a
# browser-level connection, so we Target.attachToTarget the page target
# (flatten=true) and dispatch Page.navigate against that session.
set -e -o pipefail

URL="${1:?usage: $0 <url> [host:port]}"
CDP_HOST="${2:-127.0.0.1:9226}"

for cmd in curl jq python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing: $cmd" >&2
    exit 1
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
  echo "no page target at http://${CDP_HOST}/json" >&2
  exit 1
fi

BROWSER_WS=$(curl -fsS "http://${CDP_HOST}/json/version" | jq -r '.webSocketDebuggerUrl // empty')
if [[ -z "$BROWSER_WS" ]]; then
  BROWSER_WS="ws://${CDP_HOST}/devtools/browser"
fi

echo "==> $BROWSER_WS (target=$PAGE_TARGET) -> $URL"

exec python3 - "$BROWSER_WS" "$PAGE_TARGET" "$URL" <<'PY'
import json, sys
try:
    from websockets.sync.client import connect
except ImportError:
    sys.stderr.write("missing python websockets: pip3 install websockets\n"); sys.exit(1)

ws_url, target_id, url = sys.argv[1], sys.argv[2], sys.argv[3]
with connect(ws_url, max_size=None) as ws:
    ws.send(json.dumps({
        "id": 1,
        "method": "Target.attachToTarget",
        "params": {"targetId": target_id, "flatten": True},
    }))
    session_id = None
    while session_id is None:
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            if "error" in msg:
                sys.exit(f"attach failed: {msg['error']}")
            session_id = msg["result"]["sessionId"]
    ws.send(json.dumps({
        "id": 2,
        "method": "Page.navigate",
        "sessionId": session_id,
        "params": {"url": url},
    }))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 2:
            if "error" in msg:
                sys.exit(f"navigate failed: {msg['error']}")
            print(json.dumps(msg.get("result", {})))
            break
PY
