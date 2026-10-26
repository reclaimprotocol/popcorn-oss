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
mode="$(cat "$TEST_MODE_FILE")"
timezone="$(cat "$TEST_TIMEZONE_FILE" 2>/dev/null || true)"
printf '{"metadata":{"annotations":{"popcorn.dev/browser-mode":"%s"%s}}}' "$mode" \
  "${timezone:+,\"popcorn.dev/browser-timezone\":\"$timezone\"}"
EOF
cat >"$test_dir/launcher" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s%s\n' "$BROWSER_KIOSK" "${BROWSER_PROFILE_DIR:-default}" "${BROWSER_TIMEZONE:+|$BROWSER_TIMEZONE}" >>"$TEST_LAUNCH_LOG"
trap 'exit 0' TERM INT
while true; do sleep 1; done
EOF
chmod +x "$test_dir/bin/curl" "$test_dir/launcher"

start_managed() {
  PATH="$test_dir/bin:$PATH" \
  TEST_MODE_FILE="$test_dir/mode" \
  TEST_TIMEZONE_FILE="$test_dir/timezone" \
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

start_managed
wait_for_launch 'true|default'

printf normal >"$test_dir/mode"
wait_for_launch 'false|.*/user-data-normal'
[[ "$(grep -c '^true|default$' "$test_dir/launches")" == 1 ]]
[[ "$(grep -c '^false|.*/user-data-normal$' "$test_dir/launches")" == 1 ]]

# A proxied kiosk session restarts the browser with the proxy's timezone.
kill "$managed_pid"
wait "$managed_pid" 2>/dev/null || true
rm -f "$test_dir/launches"
printf unallocated >"$test_dir/mode"
start_managed
wait_for_launch 'true|default'
printf America/Los_Angeles >"$test_dir/timezone"
printf kiosk >"$test_dir/mode"
wait_for_launch 'true|default|America/Los_Angeles'
[[ "$(cat "$test_dir/launches")" == $'true|default\ntrue|default|America/Los_Angeles' ]]
