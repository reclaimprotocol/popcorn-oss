#!/usr/bin/env bash
# Run the lightweight stealth probe battery against a running container's
# chromium over the FULL CDP proxy (9226). Dependency-light alternative to
# ../stealth-tests (no node/playwright) — just python3 + `websockets`.
#
# Usage:
#   ./stealth-test.sh                       # all probes against an existing container
#   ./stealth-test.sh --run                 # start a container first, then probe
#   ./stealth-test.sh --mobile              # apply the coherent mobile-touch profile first
#   ./stealth-test.sh fingerprint recaptcha # a subset
#   CDP_HOST=127.0.0.1:9226 ./stealth-test.sh
#
# Probes: fingerprint · sannysoft · creepjs · recaptcha · cloudflare
# Exit code: 0 all pass, 1 a probe failed/errored.
#
# NOTE: reCAPTCHA/Cloudflare weight egress IP reputation heavily — a low score
# there reflects the IP (attach a residential proxy for production), not the
# fingerprint. See ../STEALTH.md and ../stealth-tests/ for the full suite.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMAGE="${IMAGE:-popcorn/minimal-vnc-desktop:local}"
CONTAINER="${CONTAINER:-mvd-stealth}"
PLATFORM="${PLATFORM:-linux/amd64}"
CDP_HOST="${CDP_HOST:-127.0.0.1:9226}"

RUN=0
passthru=()
for arg in "$@"; do
  case "$arg" in
    --run) RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) passthru+=("$arg") ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found" >&2; exit 1
fi
if ! python3 -c "import websockets" >/dev/null 2>&1; then
  echo "missing python dep: pip3 install websockets" >&2; exit 1
fi

started=0
cleanup() { [[ "$started" == "1" ]] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if [[ "$RUN" == "1" ]]; then
  command -v docker >/dev/null 2>&1 || { echo "docker not found; cannot --run" >&2; exit 1; }
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "==> starting $CONTAINER ($IMAGE) with full CDP on 127.0.0.1:9226"
  docker run --rm -d --name "$CONTAINER" --platform "$PLATFORM" \
    --tmpfs /dev/shm:size=1g \
    -p 6080:6080 -p 127.0.0.1:9226:9226 \
    -e APP_URL=about:blank \
    "$IMAGE" >/dev/null
  started=1
  CDP_HOST="127.0.0.1:9226"
  echo -n "==> waiting for CDP …"
  for _ in $(seq 1 60); do
    curl -fsS -m2 "http://${CDP_HOST}/json/version" >/dev/null 2>&1 && { echo " up"; break; }
    sleep 1
  done
  sleep 4
fi

CDP_HOST="$CDP_HOST" python3 "$SCRIPT_DIR/stealth_probe.py" ${passthru[@]+"${passthru[@]}"}
