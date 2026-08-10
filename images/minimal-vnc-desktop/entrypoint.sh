#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-1}"
WIDTH="${WIDTH:-1920}"
HEIGHT="${HEIGHT:-1080}"
DEPTH="${DEPTH:-24}"
# Xvnc's boot geometry also fixes the BROWSER WINDOW's maximum size for the whole
# session, and that is what this extra height is for.
#
# Chromium runs --kiosk, so its window is sized to the X screen at startup and
# then never changes: measured live at 1919x1079 while the screen had long since
# been resized to 360x688 by the viewer. Kiosk CLAMPS --window-size to the screen
# (a lab instance asking for 1920x2400 on a 1920x1080 screen came up 1920x1080), so
# the screen has to be the tall one and start-chromium's --window-size must match
# it — a smaller --window-size is honoured and would re-impose the cap.
# Shrinking the screen afterwards is harmless — the window is
# bigger than the visible area — but GROWING it past the boot height leaves rows
# with no window over them, and the X root shows through as BLACK.
#
# That is exactly what fit-to-width does. A no-viewport-meta page (hanyang) is
# fitted at 980 CSS px wide, and the framebuffer has to be as tall as the phone's
# aspect implies: 980 * 689/360 = 1873 rows. The top 1079 painted the login page;
# the remaining 794 were black. Verified by geometry, not by eye — 1079/1873 is
# the 57.7% white/43.3% black split in the report.
#
# Booting the screen tall enough that no fit can outgrow the window (2400 clears the
# worst case: a ~2.2-aspect phone at the 980 cap needs ~2180 rows) fixes that band —
# but it is NOT free, and the default is now HEIGHT rather than 2400.
#
# The cost was paid by every session that does not fit-to-width. The screen IS the
# framebuffer, and it cannot be shrunk afterwards: the kiosk window follows a shrink
# down and can never be grown back, because the only CDP call that regrows it needs
# windowState "normal", and --kiosk suppresses the tab strip and omnibox ONLY while
# fullscreen (measured: 796px of real browser chrome, URL bar included, inside a
# session meant to be a locked-down viewer). So a tall boot means a permanently tall
# stream: a plain viewer showed its 1920x1080 page in the top rows of a 1920x2400
# framebuffer with ~1300 rows of blank beneath, in a 0.80-aspect portrait box.
#
# Defaulting to HEIGHT makes the common case correct — screen, kiosk window and page
# all 1920x1080. The olw left-clip fit still fits comfortably (Pinterest: 412x787).
# What it gives up is the TALL fits: ?fixedw=560 needs 1212 rows and the 980
# no-viewport fallback needs 1873, so those show the black band again.
#
# Set FB_HEIGHT=2400 explicitly to get the tall-fit behaviour back — that is the
# supported way to test a no-viewport-meta page (hanyang) without the band.
FB_HEIGHT="${FB_HEIGHT:-$HEIGHT}"
if (( FB_HEIGHT < HEIGHT )); then FB_HEIGHT="$HEIGHT"; fi
export FB_HEIGHT   # start-chromium sizes the kiosk window from it
export WIDTH HEIGHT # novnc-proxy reads them for the default viewport emulation
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

echo "[entrypoint] Starting Xvnc on ${DISPLAY} (${WIDTH}x${FB_HEIGHT}x${DEPTH}, desktop ${WIDTH}x${HEIGHT})"
# -SendPrimary=0: do NOT forward the X PRIMARY selection to the client. PRIMARY is
# claimed by merely SELECTING text, and TigerVNC forwards it by default
# (SendPrimary=1) — where the viewer mirrors any incoming clipboard into the
# DEVICE's real clipboard (kbd/clipboard.js onRemoteClipboard). So a plain Ctrl+A
# in the remote page pushed the selection to the client with no copy at all;
# verified with a canary string over raw RFB. Two consequences, both bad: remote
# content lands in the user's OS clipboard unasked, and whatever they had copied
# locally (a password they were about to paste) is destroyed — which reads as
# "paste is broken".
#
# -SetPrimary=0 is the same story inbound: without it a client cut-text also
# overwrites the remote PRIMARY. Only the real CLIPBOARD selection — a deliberate
# Ctrl+C — should cross, in either direction.
Xvnc "$DISPLAY" \
  -geometry "${WIDTH}x${FB_HEIGHT}" \
  -depth "$DEPTH" \
  -rfbport "$VNC_PORT" \
  -localhost=1 \
  -SecurityTypes None \
  -AlwaysShared=1 \
  -SendPrimary=0 \
  -SetPrimary=0 \
  -Log '*:stderr:30' \
  > "$(log_file xvnc)" 2>&1 &
pids+=("$!")

wait_for_tcp 127.0.0.1 "$VNC_PORT" Xvnc

echo "[entrypoint] Starting noVNC/CDP proxy on :${NOVNC_PORT}, ${CDP_RESTRICTED_LISTEN}, ${CDP_FULL_LISTEN}"
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

# Hide the X pointer that gets rendered into the VNC framebuffer. idle=0 hides
# it immediately; a huge jitter keeps it hidden through mouse movement. This is
# server-side (the cursor is baked into the stream), so CSS in the viewer can't
# remove it.
if [[ "${HIDE_CURSOR:-true}" == "true" ]] && command -v unclutter >/dev/null 2>&1; then
  echo "[entrypoint] Hiding cursor with unclutter"
  unclutter -idle 0 -jitter 9000000 > "$(log_file unclutter)" 2>&1 &
  pids+=("$!")
fi

echo "[entrypoint] Starting app: ${APP_COMMAND}"
bash -lc "exec ${APP_COMMAND}" > "$(log_file app)" 2>&1 &
app_pid="$!"
pids+=("$app_pid")

echo "[entrypoint] Waiting for app readiness pattern: ${READY_WINDOW_PATTERN}"
wait_for_window "$READY_WINDOW_PATTERN" "$READY_TIMEOUT" "$app_pid"

# The screen STAYS at the boot geometry (WIDTH x FB_HEIGHT). It is tempting to
# shrink it to WIDTH x HEIGHT here so a plain desktop viewer does not stream a tall
# framebuffer with a blank bottom — that was tried and reverted, and the reason is
# worth recording because it looks like it should work.
#
# A screen shrink DRAGS THE KIOSK WINDOW DOWN WITH IT, and the window can never be
# grown back. Waiting for the window to latch at FB_HEIGHT first does not help:
# measured "kiosk window latched at height 2399" and the very next xrandr still left
# the window at 1919x1080. A much later shrink (~5s+) sometimes leaves it tall, which
# makes the whole thing a race, not a design.
#
# Once the window is short, fit-to-width has nowhere to put a tall framebuffer: rows
# past the window show the black X root. The only way to regrow the window is CDP
# Browser.setWindowBounds with windowState "normal", and --kiosk suppresses the tab
# strip and omnibox ONLY while fullscreen — that attempt put 796px of real browser
# chrome, URL bar included, inside a session meant to be a locked-down viewer.
#
# So: tall screen, tall window, no black band, kiosk intact. The cost is that a
# non-fitting viewer sees WIDTH x FB_HEIGHT. If the tall default matters more than
# fit-to-width, the lever is FB_HEIGHT (set it to HEIGHT) plus a cap in kbd/fit.js so
# no fit asks for more rows than the window has — not a post-boot resize.
touch "$READY_FILE"
echo "[entrypoint] noVNC is ready"
agones_ready

wait -n "${pids[@]}"
