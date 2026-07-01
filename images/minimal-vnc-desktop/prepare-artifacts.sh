#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHROMIUM_LOCK="$SCRIPT_DIR/locks/chromium-artifacts.tsv"
MIRROR_LOCK="$SCRIPT_DIR/locks/artifact-mirrors.tsv"

usage() {
  cat <<'EOF'
Usage:
  prepare-artifacts.sh <output-dir> [platform]

Prepares a small artifact context for the minimal VNC desktop Dockerfile.
The output directory will contain artifacts/debs/*.deb.

Environment:
  GITHUB_ARTIFACT_MIRROR_REPO  Optional GitHub repo override for release assets.
  ARTIFACT_MIRROR_TAG          Optional GitHub release tag override.
  ARTIFACT_MIRROR_PREFIX       Optional unauthenticated HTTP mirror prefix.
  SOURCE_DATE_EPOCH            Optional deterministic timestamp for prepared files.
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

for cmd in awk curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

normalize_platform() {
  case "${1:-}" in
    "")
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

TARGET_PLATFORM="$(normalize_platform "$PLATFORM_INPUT")"
TARGET_ARCH="${TARGET_PLATFORM#linux/}"
ARTIFACT_ROOT="$OUT_DIR/artifacts"
DEB_DIR="$ARTIFACT_ROOT/debs"
TMP_DOWNLOAD_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DOWNLOAD_DIR"' EXIT

mirror_record="$(
  awk -F '\t' -v arch="$TARGET_ARCH" \
    '$0 !~ /^[[:space:]]*(#|$)/ && $1 == arch { print $2 "\t" $3; exit }' \
    "$MIRROR_LOCK"
)"

if [[ -z "$mirror_record" ]]; then
  echo "No artifact mirror lock for arch: $TARGET_ARCH" >&2
  exit 1
fi

IFS=$'\t' read -r locked_mirror_repo locked_mirror_tag <<<"$mirror_record"
GITHUB_ARTIFACT_MIRROR_REPO="${GITHUB_ARTIFACT_MIRROR_REPO:-$locked_mirror_repo}"
ARTIFACT_MIRROR_TAG="${ARTIFACT_MIRROR_TAG:-$locked_mirror_tag}"

mkdir -p "$DEB_DIR"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_file() {
  local path="$1"
  local expected_sha="$2"
  local actual_sha

  actual_sha="$(sha256_file "$path")"
  [[ "$actual_sha" == "$expected_sha" ]]
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
    --user-agent "minimal-vnc-desktop-artifacts/1.0" \
    --output "$out_path" \
    "$url"
}

download_artifact() {
  local filename="$1"
  local upstream_url="$2"
  local out_path="$3"
  local mirror_prefix="${ARTIFACT_MIRROR_PREFIX:-}"
  local mirror_repo="${GITHUB_ARTIFACT_MIRROR_REPO:-}"
  local mirror_tag="${ARTIFACT_MIRROR_TAG:-}"

  if [[ -n "$mirror_prefix" ]]; then
    if download_with_curl "${mirror_prefix%/}/$filename" "$out_path"; then
      return
    fi
    echo "Mirror prefix missing $filename; falling back" >&2
  fi

  if [[ -n "$mirror_repo" && -n "$mirror_tag" ]] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    rm -f "$TMP_DOWNLOAD_DIR/$filename"
    if gh release download "$mirror_tag" \
      --repo "$mirror_repo" \
      --pattern "$filename" \
      --dir "$TMP_DOWNLOAD_DIR" \
      --clobber >/dev/null; then
      if [[ "$TMP_DOWNLOAD_DIR/$filename" != "$out_path" ]]; then
        mv "$TMP_DOWNLOAD_DIR/$filename" "$out_path"
      fi
      return
    fi
    echo "GitHub artifact mirror missing $filename; falling back" >&2
  fi

  download_with_curl "$upstream_url" "$out_path"
}

while IFS=$'\t' read -r arch name filename url expected_sha; do
  if [[ "$arch" != "$TARGET_ARCH" ]]; then
    continue
  fi

  out_path="$DEB_DIR/$filename"
  if [[ -f "$out_path" ]] && verify_file "$out_path" "$expected_sha"; then
    echo "Using cached $filename"
    continue
  fi

  rm -f "$out_path"
  tmp_path="$TMP_DOWNLOAD_DIR/$filename"
  echo "Preparing $name ($filename)"
  download_artifact "$filename" "$url" "$tmp_path"

  if ! verify_file "$tmp_path" "$expected_sha"; then
    echo "Checksum mismatch for $filename" >&2
    echo "Expected: $expected_sha" >&2
    echo "Actual:   $(sha256_file "$tmp_path")" >&2
    exit 1
  fi

  mv "$tmp_path" "$out_path"
done < <(awk -F '\t' '$0 !~ /^[[:space:]]*(#|$)/ { print }' "$CHROMIUM_LOCK")

artifact_count="$(find "$DEB_DIR" -maxdepth 1 -type f -name '*.deb' | wc -l | tr -d '[:space:]')"
if [[ "$artifact_count" != "4" ]]; then
  echo "Expected 4 deb artifacts for $TARGET_ARCH, found $artifact_count" >&2
  exit 1
fi

find "$ARTIFACT_ROOT" -type f -exec chmod 0644 {} +
find "$ARTIFACT_ROOT" -type d -exec chmod 0755 {} +

touch_reproducibly() {
  local epoch="${SOURCE_DATE_EPOCH:-0}"

  if touch -h -d "@$epoch" "$ARTIFACT_ROOT" 2>/dev/null; then
    find "$ARTIFACT_ROOT" -exec touch -h -d "@$epoch" {} +
    return
  fi

  local stamp
  stamp="$(date -u -r "$epoch" +%Y%m%d%H%M.%S)"
  find "$ARTIFACT_ROOT" -exec touch -h -t "$stamp" {} +
}

touch_reproducibly
