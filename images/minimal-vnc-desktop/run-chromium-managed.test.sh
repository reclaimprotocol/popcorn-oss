#!/usr/bin/env bash
set -euo pipefail

test_dir="$(mktemp -d)"
managed_pid=""
cleanup() {
  [[ -z "$managed_pid" ]] || kill "$managed_pid" 2>/dev/null || true
  rm -rf "$test_dir"
}
trap cleanup EXIT
mkdir -p "$test_dir/bin"
printf unallocated >"$test_dir/mode"

cat >"$test_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
# An announcement is recorded with the launches seen so far, so a test can tell
# which browser was running when a session was named.
if [[ "$*" == */metadata/annotation* ]]; then
  [[ ! -e "$TEST_ANNOUNCE_FAILS" ]] || exit 22
  sleep 0.1 # the browser started just before this call logs its launch on its own time
  launches=0
  [[ ! -f "$TEST_LAUNCH_LOG" ]] || launches="$(wc -l <"$TEST_LAUNCH_LOG" | tr -d ' ')"
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --data ]]; then
      printf '%s after %s launches\n' "$2" "$launches" >>"$TEST_ANNOUNCE_LOG"
      # The game server shows a record only once TEST_RECORD_HIDDEN is gone.
      [[ "$2" =~ \"value\":\"([^\"]+)\" ]] && printf %s "${BASH_REMATCH[1]}" >"$TEST_RECORD_FILE"
    fi
    shift
  done
  exit 0
fi
recorded=""
[[ -e "$TEST_RECORD_HIDDEN" ]] || recorded="$(cat "$TEST_RECORD_FILE" 2>/dev/null || true)"
mode="$(cat "$TEST_MODE_FILE")"
session="$(cat "$TEST_SESSION_FILE" 2>/dev/null || true)"
timezone="$(cat "$TEST_TIMEZONE_FILE" 2>/dev/null || true)"
public_ip="$(cat "$TEST_PUBLIC_IP_FILE" 2>/dev/null || true)"
printf '{"metadata":{"annotations":{"popcorn.dev/browser-mode":"%s"%s%s%s%s}}}' "$mode" \
  "${recorded:+,\"agones.dev/sdk-browser-launch\":\"$recorded\"}" \
  "${session:+,\"popcorn.dev/session-id\":\"$session\"}" \
  "${timezone:+,\"popcorn.dev/browser-timezone\":\"$timezone\"}" \
  "${public_ip:+,\"popcorn.dev/browser-public-ip\":\"$public_ip\"}"
EOF
cat >"$test_dir/launcher" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s%s%s\n' "$BROWSER_KIOSK" "${BROWSER_PROFILE_DIR:-default}" "${BROWSER_TIMEZONE:+|$BROWSER_TIMEZONE}" "${BROWSER_PUBLIC_IP:+|$BROWSER_PUBLIC_IP}" >>"$TEST_LAUNCH_LOG"
trap 'exit 0' TERM INT
while true; do sleep 1; done
EOF
chmod +x "$test_dir/bin/curl" "$test_dir/launcher"

start_managed() {
  PATH="$test_dir/bin:$PATH" \
  TEST_MODE_FILE="$test_dir/mode" \
  TEST_TIMEZONE_FILE="$test_dir/timezone" \
  TEST_PUBLIC_IP_FILE="$test_dir/public_ip" \
  TEST_SESSION_FILE="$test_dir/session" \
  TEST_ANNOUNCE_LOG="$test_dir/announcements" \
  TEST_ANNOUNCE_FAILS="$test_dir/announce-fails" \
  TEST_RECORD_FILE="$test_dir/record" \
  TEST_RECORD_HIDDEN="$test_dir/record-hidden" \
  ENABLE_AGONES=true \
  TEST_LAUNCH_LOG="$test_dir/launches" \
  CHROMIUM_LAUNCHER="$test_dir/launcher" \
  BROWSER_MODE_POLL_SECONDS=0.05 \
  bash ./run-chromium-managed >"$test_dir/output" 2>&1 &
  managed_pid="$!"
}

wait_for_launch() {
  for _ in $(seq 1 40); do
    [[ -f "$test_dir/launches" ]] && grep -qx "$1" "$test_dir/launches" && break
    sleep 0.05
  done
  grep -qx "$1" "$test_dir/launches"
}

wait_for_announcement() {
  for _ in $(seq 1 40); do
    [[ -f "$test_dir/announcements" ]] && grep -qx "$1" "$test_dir/announcements" && break
    sleep 0.05
  done
  grep -qx "$1" "$test_dir/announcements"
}

restart_managed() {
  kill "$managed_pid"
  wait "$managed_pid" 2>/dev/null || true
  rm -f "$test_dir/launches" "$test_dir/announcements" "$test_dir/announce-fails" "$test_dir/record" "$test_dir/record-hidden"
  printf unallocated >"$test_dir/mode"
  start_managed
  wait_for_launch 'true|default'
}

# No browser is started until the game server shows the pool record: a pod
# cannot report ready, and so cannot be allocated, without one.
: >"$test_dir/record-hidden"
start_managed
wait_for_announcement '{"key":"browser-launch","value":"pool"} after 0 launches'
sleep 0.3
[[ ! -e "$test_dir/launches" ]]
rm "$test_dir/record-hidden"
wait_for_launch 'true|default'

printf session-a >"$test_dir/session"
printf normal >"$test_dir/mode"
wait_for_launch 'false|.*/user-data-normal'
[[ "$(grep -c '^true|default$' "$test_dir/launches")" == 1 ]]
[[ "$(grep -c '^false|.*/user-data-normal$' "$test_dir/launches")" == 1 ]]
# The session is named only once its own browser has been started.
wait_for_announcement '{"key":"browser-launch","value":"session-a"} after 2 launches'
! grep -q 'session-a.*after 1 launches' "$test_dir/announcements"

# A session that wants the browser already running is named without a restart.
restart_managed
printf session-b >"$test_dir/session"
printf kiosk >"$test_dir/mode"
wait_for_announcement '{"key":"browser-launch","value":"session-b"} after 1 launches'
[[ "$(wc -l <"$test_dir/launches")" -eq 1 ]]

# An announcement the game server did not accept is repeated until it does.
restart_managed
: >"$test_dir/announce-fails"
printf session-c >"$test_dir/session"
printf normal >"$test_dir/mode"
wait_for_launch 'false|.*/user-data-normal'
sleep 0.3
! grep -q session-c "$test_dir/announcements"
rm "$test_dir/announce-fails"
wait_for_announcement '{"key":"browser-launch","value":"session-c"} after 2 launches'

# A proxied kiosk session restarts the browser, on a clean profile, with the
# proxy exit's timezone and public IP.
restart_managed
printf session-d >"$test_dir/session"
printf America/Los_Angeles >"$test_dir/timezone"
printf 203.0.113.7 >"$test_dir/public_ip"
printf kiosk >"$test_dir/mode"
wait_for_launch 'true|.*/user-data-session|America/Los_Angeles|203.0.113.7'
[[ "$(wc -l <"$test_dir/launches")" -eq 2 ]]
[[ "$(head -1 "$test_dir/launches")" == 'true|default' ]]
wait_for_announcement '{"key":"browser-launch","value":"session-d"} after 2 launches'
