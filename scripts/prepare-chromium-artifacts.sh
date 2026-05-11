#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
LOCK_FILE="$REPO_ROOT/popcorn-images/images/chromium-headful/chromium-lock.json"

usage() {
  cat <<'EOF'
Usage:
  scripts/prepare-chromium-artifacts.sh <output-dir> [platform]

Prepares the Chromium headful artifact context expected by the browser base
Dockerfile. The output directory will contain an artifacts/ tree.

Environment:
  GITHUB_ARTIFACT_MIRROR_REPO  Optional GitHub repo with release assets.
  ARTIFACT_MIRROR_PREFIX       Optional unauthenticated HTTP mirror prefix.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

OUT_DIR="${1:-}"
PLATFORM_INPUT="${2:-${PLATFORM:-}}"

if [[ -z "$OUT_DIR" ]]; then
  usage >&2
  exit 1
fi

for cmd in python3 curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

eval "$("$SCRIPT_DIR/chromium-lock-env.sh" "$PLATFORM_INPUT")"

GITHUB_ARTIFACT_MIRROR_REPO="${GITHUB_ARTIFACT_MIRROR_REPO:-reclaimprotocol/popcorn}"
ARTIFACT_ROOT="$OUT_DIR/artifacts"
ARTIFACT_LIST_FILE="$(mktemp)"
TMP_DOWNLOAD_DIR="$(mktemp -d)"
trap 'rm -f "$ARTIFACT_LIST_FILE"; rm -rf "$TMP_DOWNLOAD_DIR"' EXIT

rm -rf "$ARTIFACT_ROOT"
mkdir -p "$ARTIFACT_ROOT/debs" "$ARTIFACT_ROOT/archives" "$ARTIFACT_ROOT/bin"

python3 - "$LOCK_FILE" "$TARGET_ARCH" >"$ARTIFACT_LIST_FILE" <<'PY'
import json
import pathlib
import sys

lock_path = pathlib.Path(sys.argv[1])
target_arch = sys.argv[2]
lock = json.loads(lock_path.read_text())

artifacts = [
    *((artifact, "debs") for artifact in lock["chromium"]["packages"][target_arch]),
    (lock["libxcvt0"]["packages"][target_arch], "debs"),
    (lock["ffmpeg"]["archives"][target_arch], "archives"),
    (lock["websocat"]["binaries"][target_arch], "bin"),
]

for artifact, subdir in artifacts:
    print(f'{artifact["filename"]}\t{artifact["url"]}\t{artifact["sha256"]}\t{subdir}')
PY

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

download_with_curl() {
  local url="$1"
  local out_path="$2"

  curl \
    --fail \
    --location \
    --retry 8 \
    --retry-all-errors \
    --retry-delay 2 \
    --connect-timeout 20 \
    --max-time 1800 \
    --user-agent "popcorn-chromium-artifact-mirror/1.0" \
    --output "$out_path" \
    "$url"
}

download_artifact() {
  local filename="$1"
  local upstream_url="$2"
  local out_path="$3"
  local mirror_prefix="${ARTIFACT_MIRROR_PREFIX:-}"
  local mirror_repo="${GITHUB_ARTIFACT_MIRROR_REPO:-}"

  if [[ -n "$mirror_prefix" ]]; then
    if download_with_curl "${mirror_prefix%/}/$filename" "$out_path"; then
      return
    fi
    echo "Mirror prefix missing $filename; falling back" >&2
  fi

  if [[ -n "$mirror_repo" ]] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    rm -f "$TMP_DOWNLOAD_DIR/$filename"
    if gh release download "$ARTIFACT_MIRROR_TAG" \
      --repo "$mirror_repo" \
      --pattern "$filename" \
      --dir "$TMP_DOWNLOAD_DIR" \
      --clobber >/dev/null; then
      mv "$TMP_DOWNLOAD_DIR/$filename" "$out_path"
      return
    fi
    echo "GitHub mirror missing $filename; falling back" >&2
  fi

  download_with_curl "$upstream_url" "$out_path"
}

while IFS=$'\t' read -r filename url expected_sha subdir; do
  out_path="$ARTIFACT_ROOT/$subdir/$filename"
  echo "Preparing $filename"
  download_artifact "$filename" "$url" "$out_path"

  actual_sha="$(sha256_file "$out_path")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "Checksum mismatch for $filename" >&2
    echo "Expected: $expected_sha" >&2
    echo "Actual:   $actual_sha" >&2
    exit 1
  fi
done <"$ARTIFACT_LIST_FILE"

python3 - "$LOCK_FILE" "$TARGET_ARCH" "$ARTIFACT_ROOT/manifest.json" <<'PY'
import json
import pathlib
import sys

lock = json.loads(pathlib.Path(sys.argv[1]).read_text())
arch = sys.argv[2]
out_path = pathlib.Path(sys.argv[3])

manifest = {
    "arch": arch,
    "ubuntu_snapshot": lock["ubuntu_snapshot"],
    "chromium_version": lock["chromium"]["version"],
    "ffmpeg_version": lock["ffmpeg"]["version"],
    "websocat_version": lock["websocat"]["version"],
    "generated_by": "prepare-chromium-artifacts.sh",
}
out_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY

find "$ARTIFACT_ROOT" -type f -exec chmod 0644 {} +
find "$ARTIFACT_ROOT" -type d -exec chmod 0755 {} +

touch_reproducibly() {
  local epoch="${SOURCE_DATE_EPOCH:-0}"

  if touch -h -d "@$epoch" "$ARTIFACT_ROOT/manifest.json" 2>/dev/null; then
    find "$ARTIFACT_ROOT" -exec touch -h -d "@$epoch" {} +
    return
  fi

  local stamp
  stamp="$(date -u -r "$epoch" +%Y%m%d%H%M.%S)"
  find "$ARTIFACT_ROOT" -exec touch -h -t "$stamp" {} +
}

touch_reproducibly
