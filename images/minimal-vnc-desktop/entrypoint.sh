#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-1}"
WIDTH="${WIDTH:-1920}"
HEIGHT="${HEIGHT:-1080}"
DEPTH="${DEPTH:-24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
CDP_INTERNAL_PORT="${CDP_INTERNAL_PORT:-${CHROME_REMOTE_DEBUGGING_PORT:-9223}}"
CDP_RESTRICTED_PORT="${CDP_RESTRICTED_PORT:-${DEVTOOLS_PROXY_PORT:-9222}}"
CDP_FULL_PORT="${CDP_FULL_PORT:-9226}"
CDP_UPSTREAM_ADDR="${CDP_UPSTREAM_ADDR:-127.0.0.1:${CDP_INTERNAL_PORT}}"
CDP_RESTRICTED_LISTEN="${CDP_RESTRICTED_LISTEN:-0.0.0.0:${CDP_RESTRICTED_PORT}}"
CDP_FULL_LISTEN="${CDP_FULL_LISTEN:-0.0.0.0:${CDP_FULL_PORT}}"
APP_COMMAND="${APP_COMMAND:-/usr/local/bin/start-chromium}"
READY_FILE="${READY_FILE:-/tmp/minimal-vnc-ready}"
READY_TIMEOUT="${READY_TIMEOUT:-30}"
LOG_DIR="${LOG_DIR:-/var/log/app}"
ENABLE_AGONES="${ENABLE_AGONES:-auto}"
AGONES_SDK_HOST="${AGONES_SDK_HOST:-127.0.0.1}"
AGONES_SDK_HTTP_PORT="${AGONES_SDK_HTTP_PORT:-${AGONES_SDK_PORT:-9358}}"
AGONES_HEALTH_INTERVAL="${AGONES_HEALTH_INTERVAL:-2}"

export DISPLAY=":${DISPLAY_NUM}"
export HOME="${HOME:-/home/kernel}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export CDP_INTERNAL_PORT
export CHROME_REMOTE_DEBUGGING_PORT="$CDP_INTERNAL_PORT"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$HOME/user-data" /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

pids=()
cleanup_done=false
AGONES_ENABLED=false
AGONES_HEALTH_PID=""

setup_logging() {
  local requested_log_dir="$LOG_DIR"

  if ! mkdir -p "$LOG_DIR" 2>/dev/null || ! touch "$LOG_DIR/.write-test" 2>/dev/null; then
    LOG_DIR="/tmp/minimal-vnc-logs"
    mkdir -p "$LOG_DIR"
    echo "[entrypoint] warning: ${requested_log_dir} is not writable; using ${LOG_DIR}" >&2
  else
    rm -f "$LOG_DIR/.write-test"
  fi

  export LOG_DIR
  exec > >(tee -a "$LOG_DIR/entrypoint.log") 2>&1
  echo "[entrypoint] Writing logs to ${LOG_DIR}"
}

log_file() {
  printf '%s/%s.log' "$LOG_DIR" "$1"
}

configure_agones() {
  case "$ENABLE_AGONES" in
    1 | true | TRUE | yes | YES)
      AGONES_ENABLED=true
      ;;
    0 | false | FALSE | no | NO)
      AGONES_ENABLED=false
      ;;
    auto)
      if [[ -n "${POD_NAME:-}" || -n "${KUBERNETES_SERVICE_HOST:-}" ]]; then
        AGONES_ENABLED=true
      fi
      ;;
    *)
      echo "[entrypoint] unknown ENABLE_AGONES=${ENABLE_AGONES}; disabling Agones lifecycle" >&2
      AGONES_ENABLED=false
      ;;
  esac
}

agones_post() {
  local path="$1"
  local fd
  local status

  if [[ "$AGONES_ENABLED" != "true" ]]; then
    return 0
  fi

  if ! exec {fd}<>"/dev/tcp/${AGONES_SDK_HOST}/${AGONES_SDK_HTTP_PORT}" 2>/dev/null; then
    return 1
  fi

  printf 'POST /%s HTTP/1.1\r\nHost: %s:%s\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}' \
    "$path" "$AGONES_SDK_HOST" "$AGONES_SDK_HTTP_PORT" >&"$fd" || {
      exec {fd}>&- 2>/dev/null || true
      return 1
    }

  if ! IFS= read -r -t 2 status <&"$fd"; then
    exec {fd}>&- 2>/dev/null || true
    return 1
  fi

  exec {fd}>&- 2>/dev/null || true
  [[ "$status" =~ ^HTTP/[0-9.]+[[:space:]]+2[0-9][0-9] ]]
}

agones_ready() {
  if [[ "$AGONES_ENABLED" != "true" ]]; then
    return 0
  fi
  echo "[entrypoint] Signaling Agones: READY"
  agones_post ready || echo "[entrypoint] failed to signal Agones ready" >&2
}

agones_shutdown() {
  if [[ "$AGONES_ENABLED" != "true" ]]; then
    return 0
  fi
  echo "[entrypoint] Signaling Agones: SHUTDOWN"
  agones_post shutdown || echo "[entrypoint] failed to signal Agones shutdown" >&2
}

start_agones_health() {
  if [[ "$AGONES_ENABLED" != "true" ]]; then
    return 0
  fi
  echo "[entrypoint] Starting Agones health pings"
  while true; do
    agones_post health >/dev/null 2>&1 || true
    sleep "$AGONES_HEALTH_INTERVAL"
  done &
  AGONES_HEALTH_PID="$!"
}

cleanup() {
  if [[ "$cleanup_done" == "true" ]]; then
    return
  fi
  cleanup_done=true
  if [[ -n "$AGONES_HEALTH_PID" ]] && kill -0 "$AGONES_HEALTH_PID" 2>/dev/null; then
    kill "$AGONES_HEALTH_PID" 2>/dev/null || true
  fi
  agones_shutdown
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local name="$3"
  local attempts="${4:-100}"
  local sleep_secs="${5:-0.05}"

  for _ in $(seq 1 "$attempts"); do
    if (: <>"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      echo "[entrypoint] ${name} is listening on ${host}:${port}"
      return 0
    fi
    sleep "$sleep_secs"
  done

  echo "[entrypoint] ${name} did not start listening on ${host}:${port}" >&2
  return 1
}

default_ready_window_pattern() {
  local command_bin
  read -r command_bin _ <<<"$APP_COMMAND"
  command_bin="${command_bin##*/}"

  case "$command_bin" in
    *chromium* | *chrome*)
      printf '%s\n' 'chromium|chrome'
      ;;
    "")
      printf '%s\n' '.'
      ;;
    *)
      printf '%s\n' "$command_bin"
      ;;
  esac
}

wait_for_window() {
  local pattern="$1"
  local timeout_secs="$2"
  local app_pid="$3"
  local attempts
  local window_tree

  if ! command -v xwininfo >/dev/null 2>&1; then
    echo "[entrypoint] xwininfo is unavailable; cannot verify app readiness" >&2
    return 1
  fi

  attempts=$((timeout_secs * 10))
  if ((attempts < 1)); then
    attempts=1
  fi

  for _ in $(seq 1 "$attempts"); do
    if ! kill -0 "$app_pid" 2>/dev/null; then
      echo "[entrypoint] app exited before readiness: ${APP_COMMAND}" >&2
      return 1
    fi

    window_tree="$(xwininfo -root -tree 2>/dev/null || true)"
    if grep -Eiq "$pattern" <<<"$window_tree"; then
      echo "[entrypoint] app window matched readiness pattern: ${pattern}"
      return 0
    fi

    sleep 0.1
  done

  echo "[entrypoint] app did not match readiness pattern within ${timeout_secs}s: ${pattern}" >&2
  return 1
}

rm -f "$READY_FILE"
READY_WINDOW_PATTERN="${READY_WINDOW_PATTERN:-$(default_ready_window_pattern)}"
setup_logging
configure_agones
start_agones_health

echo "[entrypoint] Starting Xvnc on ${DISPLAY} (${WIDTH}x${HEIGHT}x${DEPTH})"
Xvnc "$DISPLAY" \
  -geometry "${WIDTH}x${HEIGHT}" \
  -depth "$DEPTH" \
  -rfbport "$VNC_PORT" \
  -localhost=1 \
  -SecurityTypes None \
  -AlwaysShared=1 \
  -Log '*:stderr:30' \
  > "$(log_file xvnc)" 2>&1 &
pids+=("$!")

wait_for_tcp 127.0.0.1 "$VNC_PORT" Xvnc

echo "[entrypoint] Starting noVNC/CDP proxy on :${NOVNC_PORT}, ${CDP_RESTRICTED_LISTEN}, ${CDP_FULL_LISTEN}"
# The proxy injects a payload-safe logger into reclaim-tee. Inheriting stdout
# sends proxy, proof lifecycle, and TEE library events through the existing
# entrypoint tee to both entrypoint.log and Kubernetes/OpenTelemetry.
novnc-proxy \
  --listen "0.0.0.0:${NOVNC_PORT}" \
  --vnc "127.0.0.1:${VNC_PORT}" \
  --web /usr/share/novnc \
  --ready-file "$READY_FILE" \
  --cdp-upstream "$CDP_UPSTREAM_ADDR" \
  --cdp-restricted-listen "$CDP_RESTRICTED_LISTEN" \
  --cdp-full-listen "$CDP_FULL_LISTEN" &
pids+=("$!")

wait_for_tcp 127.0.0.1 "$NOVNC_PORT" "noVNC proxy"
if [[ "$CDP_RESTRICTED_LISTEN" != "" ]]; then
  wait_for_tcp 127.0.0.1 "${CDP_RESTRICTED_LISTEN##*:}" "restricted CDP proxy"
fi
if [[ "$CDP_FULL_LISTEN" != "" ]]; then
  wait_for_tcp 127.0.0.1 "${CDP_FULL_LISTEN##*:}" "full CDP proxy"
fi

echo "[entrypoint] Starting openbox"
openbox > "$(log_file openbox)" 2>&1 &
pids+=("$!")

echo "[entrypoint] Starting app: ${APP_COMMAND}"
bash -lc "exec ${APP_COMMAND}" > "$(log_file app)" 2>&1 &
app_pid="$!"
pids+=("$app_pid")

echo "[entrypoint] Waiting for app readiness pattern: ${READY_WINDOW_PATTERN}"
wait_for_window "$READY_WINDOW_PATTERN" "$READY_TIMEOUT" "$app_pid"
touch "$READY_FILE"
echo "[entrypoint] noVNC is ready"
agones_ready

wait -n "${pids[@]}"
