#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
LOCK_FILE="$REPO_ROOT/popcorn-images/images/chromium-headful/chromium-lock.json"

platform_input="${1:-}"

normalize_platform() {
  case "${1:-}" in
    "" )
      case "$(uname -m)" in
        x86_64|amd64) echo "linux/amd64" ;;
        arm64|aarch64) echo "linux/arm64" ;;
        *)
          echo "Unsupported host architecture: $(uname -m)" >&2
          exit 1
          ;;
      esac
      ;;
    linux/amd64|amd64|x86_64) echo "linux/amd64" ;;
    linux/arm64|arm64|aarch64) echo "linux/arm64" ;;
    *)
      echo "Unsupported platform: $1" >&2
      exit 1
      ;;
  esac
}

TARGET_PLATFORM="$(normalize_platform "$platform_input")"
TARGET_ARCH="${TARGET_PLATFORM#linux/}"

LOCK_OUTPUT="$(
  python3 - "$LOCK_FILE" "$TARGET_ARCH" <<'PY'
import hashlib
import json
import pathlib
import sys

lock_path = pathlib.Path(sys.argv[1])
target_arch = sys.argv[2]
raw = lock_path.read_bytes()
lock = json.loads(raw)

if target_arch not in lock.get("chromium", {}).get("packages", {}):
    raise SystemExit(f"unsupported arch in lock file: {target_arch}")

tag_hash = hashlib.sha256(raw + b"\0" + target_arch.encode("utf-8")).hexdigest()[:16]

print(lock["ubuntu_snapshot"])
print(f"lock-{target_arch}-{tag_hash}")
PY
)"
UBUNTU_SNAPSHOT="${LOCK_OUTPUT%%$'\n'*}"
ARTIFACT_MIRROR_TAG="${LOCK_OUTPUT#*$'\n'}"

cat <<EOF
export TARGET_PLATFORM=${TARGET_PLATFORM}
export TARGET_ARCH=${TARGET_ARCH}
export UBUNTU_SNAPSHOT=${UBUNTU_SNAPSHOT}
export ARTIFACT_MIRROR_TAG=${ARTIFACT_MIRROR_TAG}
EOF
