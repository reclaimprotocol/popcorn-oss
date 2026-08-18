#!/usr/bin/env bash
# Expose the local noVNC viewer over a Cloudflare quick-tunnel so you can open
# it on a phone and test the mobile keyboard / IME end-to-end.
#
# Everything the viewer needs is on ONE port (default 6080): the noVNC page,
# the /websockify VNC stream, and the /kbd focus-signal channel. The tunnel
# serves it over HTTPS, so the viewer's ws:// upgrades to wss:// automatically
# (required by iOS Safari and by the /kbd + /websockify sockets).
#
# Usage:
#   ./tunnel.sh              # tunnel an already-running container's :6080
#   ./tunnel.sh --run        # start the container first, then tunnel
#   ./tunnel.sh --run --embed         # ALSO serve the minimal embedded harness
#   ./tunnel.sh --run --embed-nested  # three-frame embedded harness + keyboard debug panel
#   NOVNC_PORT=6080 IMAGE=popcorn/minimal-vnc-desktop:local ./tunnel.sh --run
#
# --embed (or EMBED=1) is for testing the iframe-embedded path the portal/SDK uses.
# It serves host/ from a local static server behind its OWN quick tunnel, so the
# harness lands on a DIFFERENT https origin than the viewer — which is the point:
# same-origin embedding would silently pass even if the postMessage bridge, the
# origin checks or the Permissions-Policy delegation were broken.
#
# --embed-nested adds an intermediate relay frame, reproducing the full
# SDK -> portal -> liveview topology. It opens the debug harness so the phone
# can show the measured keyboard occlusion and forwarded viewport events.
#
# NOTE: on Apple Silicon the amd64 Fortress Chromium SIGTRAPs under emulation
# (see the Dockerfile). Run this on a native amd64 host, or point it at a
# container running elsewhere that publishes :6080 to this machine.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

PORT="${NOVNC_PORT:-6080}"
IMAGE="${IMAGE:-popcorn/minimal-vnc-desktop:local}"
CONTAINER="${CONTAINER:-minimal-vnc-desktop}"
# Fortress (the browser engine) is amd64-only, so the image is always amd64 —
# keep the platform pinned. On Apple Silicon it runs under emulation (see the
# SIGTRAP note above); an arm64 default would build/run the wrong image.
PLATFORM="${PLATFORM:-linux/amd64}"
RUN=0
EMBED="${EMBED:-0}"
NESTED_EMBED=0
HOST_PORT="${HOST_PORT:-8080}"
HOST_DIR="$SCRIPT_DIR/../host"

for arg in "$@"; do
  case "$arg" in
    --run) RUN=1 ;;
    --embed) EMBED=1 ;;
    --embed-nested) EMBED=1; NESTED_EMBED=1 ;;
    --port=*) PORT="${arg#*=}" ;;
    --host-port=*) HOST_PORT="${arg#*=}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v cloudflared >/dev/null 2>&1; then
  cat >&2 <<'EOF'
cloudflared is not installed. Install it:
  macOS:  brew install cloudflared
  linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
EOF
  exit 1
fi

started_container=0
if [[ "$RUN" == "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found; cannot --run" >&2; exit 1
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "==> starting $CONTAINER ($IMAGE, $PLATFORM) publishing :$PORT"
  # Chromium runs in --kiosk (no address bar), so the page to open is set via
  # APP_URL. Default keeps the image default; override to land on a test page,
  # e.g. APP_URL=https://www.kaggle.com/account/login ./tunnel.sh --run
  #
  # PUBLISH_CDP=1 also maps the full CDP endpoint (9226) to 127.0.0.1 ONLY, so
  # cdp-navigate.sh can retarget the live browser. It is deliberately NOT
  # tunnelled — exposing unfiltered CDP publicly would hand anyone control of
  # the browser. Only the viewer (6080) goes through the public tunnel.
  cdp_pub=()
  if [[ "${PUBLISH_CDP:-0}" == "1" ]]; then
    cdp_pub=(-p 127.0.0.1:9226:9226)
    echo "==> publishing full CDP on 127.0.0.1:9226 (local only)"
  fi
  # ${arr[@]+"${arr[@]}"} expands to nothing when the array is empty instead of
  # tripping `set -u` on macOS's bash 3.2 (where "${empty[@]}" is "unbound").
  # WIDTH/HEIGHT set the remote framebuffer geometry (the Xvnc display + chromium
  # window). Launch PORTRAIT (e.g. WIDTH=1080 HEIGHT=1920) for a mobile-shaped
  # display — same ~1080p pixel budget as landscape, but the mobile page fills it
  # so magnify renders crisp with no aspect-mismatch letterboxing.
  docker run --rm -d --name "$CONTAINER" --platform "$PLATFORM" \
    -p "${PORT}:6080" \
    ${cdp_pub[@]+"${cdp_pub[@]}"} \
    ${APP_URL:+-e "APP_URL=${APP_URL}"} \
    ${WIDTH:+-e "WIDTH=${WIDTH}"} \
    ${HEIGHT:+-e "HEIGHT=${HEIGHT}"} \
    ${DEPTH:+-e "DEPTH=${DEPTH}"} \
    "$IMAGE" >/dev/null
  started_container=1
fi

# Wait for the local origin to accept connections, so the tunnel doesn't serve
# 502s before the container is ready. Prefer curl — bash's /dev/tcp gives false
# negatives against Docker Desktop's port forwarding on macOS.
echo "==> waiting for http://localhost:${PORT} to come up …"
up=0
probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -sS -m 2 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null && { exec 3>&- 3<&-; }
  fi
}
for _ in $(seq 1 120); do
  if probe; then up=1; break; fi
  sleep 0.5
done
if [[ "$up" != "1" ]]; then
  echo "!! nothing is listening on :${PORT} yet — starting the tunnel anyway." >&2
  echo "   (start the container, or check it didn't SIGTRAP on a non-amd64 host)" >&2
fi

TUNNEL_LOG="$SCRIPT_DIR/.tmp/cloudflared.log"
mkdir -p "$(dirname "$TUNNEL_LOG")"
: > "$TUNNEL_LOG"

cloudflared tunnel --url "http://localhost:${PORT}" >>"$TUNNEL_LOG" 2>&1 &
tunnel_pid=$!

# --embed: static-serve host/ and give it its own tunnel = a second https origin.
host_srv_pid=""
host_tunnel_pid=""
HOST_TUNNEL_LOG="$SCRIPT_DIR/.tmp/cloudflared-host.log"
if [[ "$EMBED" == "1" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "!! --embed needs python3 for the static server; skipping the embed tunnel." >&2
    EMBED=0
  else
    echo "==> serving $HOST_DIR on :${HOST_PORT} (embed harness)"
    # Served with host/ AS THE ROOT so test-min.html's relative popcorn-host.js
    # resolves — the harness pages are written to be origin-root-agnostic.
    python3 -m http.server "$HOST_PORT" --directory "$HOST_DIR" >/dev/null 2>&1 &
    host_srv_pid=$!
    : > "$HOST_TUNNEL_LOG"
    cloudflared tunnel --url "http://localhost:${HOST_PORT}" >>"$HOST_TUNNEL_LOG" 2>&1 &
    host_tunnel_pid=$!
  fi
fi

cleanup() {
  for pid in "$tunnel_pid" "$host_tunnel_pid" "$host_srv_pid"; do
    [[ -n "$pid" ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [[ "$started_container" == "1" ]]; then
    echo "==> stopping container $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# cloudflared prints the assigned URL in a banner; pull it out.
wait_for_url() { # log, pid -> prints the url (empty on timeout/exit)
  local log="$1" pid="$2" u=""
  for _ in $(seq 1 60); do
    u=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -n1 || true)
    [[ -n "$u" ]] && { printf '%s' "$u"; return 0; }
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}
url=$(wait_for_url "$TUNNEL_LOG" "$tunnel_pid") || {
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    echo "cloudflared exited; log:" >&2; cat "$TUNNEL_LOG" >&2; exit 1
  fi
  url=""
}

if [[ -z "$url" ]]; then
  echo "!! cloudflared didn't report a URL yet; tailing ${TUNNEL_LOG} (Ctrl-C to stop)…"
  tail -f "$TUNNEL_LOG"
  exit 0
fi

embed_block=""
if [[ "$EMBED" == "1" ]]; then
  host_url=$(wait_for_url "$HOST_TUNNEL_LOG" "$host_tunnel_pid") || host_url=""
  if [[ -n "$host_url" ]]; then
    harness="test-min.html"
    harness_query="viewer=${url}"
    if [[ "$NESTED_EMBED" == "1" ]]; then
      harness="test-host.html"
      harness_query="viewer=${url}&nest=1&kbddebug=1"
    fi
    embed_block="
  EMBEDDED (what the portal/SDK actually ships — cross-origin iframe):

      ${host_url}/${harness}?${harness_query}

  - test-min.html is the bare full-viewport iframe (sharp).
    test-host.html is the same thing plus a debug panel.
    --embed-nested selects test-host.html with the 3-level SDK->portal->viewer chain.
  - Host tunnel log: ${HOST_TUNNEL_LOG}
"
  else
    embed_block="
  !! the embed tunnel didn't report a URL — see ${HOST_TUNNEL_LOG}
"
  fi
fi

cat <<EOF

============================================================
  Open this on your phone:

      ${url}/liveview.html?magnify=1
${embed_block}
  - HTTPS origin -> /websockify and /kbd run over wss (works).
  - Tap a text field in the remote page: the soft keyboard
    should pop, type/backspace/IME should reach the field.
  - Watch the keyboard signal path here:
        tail -f ${TUNNEL_LOG}
  - Ctrl-C to stop the tunnel$( [[ "$started_container" == "1" ]] && printf ' and the container' ).
============================================================

EOF

wait "$tunnel_pid"
