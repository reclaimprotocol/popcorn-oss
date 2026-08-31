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
printf '{"metadata":{"annotations":{"popcorn.dev/browser-mode":"%s"}}}' "$mode"
EOF
cat >"$test_dir/launcher" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "$BROWSER_KIOSK" "${BROWSER_PROFILE_DIR:-default}" >>"$TEST_LAUNCH_LOG"
trap 'exit 0' TERM INT
while true; do sleep 1; done
EOF
chmod +x "$test_dir/bin/curl" "$test_dir/launcher"

PATH="$test_dir/bin:$PATH" \
TEST_MODE_FILE="$test_dir/mode" \
TEST_LAUNCH_LOG="$test_dir/launches" \
CHROMIUM_LAUNCHER="$test_dir/launcher" \
BROWSER_MODE_POLL_SECONDS=0.05 \
bash ./run-chromium-managed >"$test_dir/output" 2>&1 &
managed_pid="$!"

for _ in $(seq 1 40); do
  [[ -f "$test_dir/launches" ]] && grep -qx 'true|default' "$test_dir/launches" && break
  sleep 0.05
done
grep -qx 'true|default' "$test_dir/launches"

printf normal >"$test_dir/mode"
for _ in $(seq 1 40); do
  [[ -f "$test_dir/launches" ]] && grep -qx 'false|.*/user-data-normal' "$test_dir/launches" && break
  sleep 0.05
done
grep -qx 'false|.*/user-data-normal' "$test_dir/launches"
[[ "$(grep -c '^true|default$' "$test_dir/launches")" == 1 ]]
[[ "$(grep -c '^false|.*/user-data-normal$' "$test_dir/launches")" == 1 ]]
