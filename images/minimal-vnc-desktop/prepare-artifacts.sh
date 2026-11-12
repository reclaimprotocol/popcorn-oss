#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHROMIUM_LOCK="$SCRIPT_DIR/locks/chromium-artifacts.tsv"
APT_LOCK="$SCRIPT_DIR/locks/apt-debs.tsv"
MIRROR_LOCK="$SCRIPT_DIR/locks/artifact-mirrors.tsv"

usage() {
  cat <<'EOF'
Usage:
  prepare-artifacts.sh <output-dir> [platform]

Prepares the artifact context for the minimal VNC desktop Dockerfile:
  artifacts/debs/*.deb  the prepared debs in locks/chromium-artifacts.tsv
  artifacts/apt/*.deb   every Ubuntu deb in locks/apt-debs.tsv

The build installs these files and never contacts an apt archive. Each file is
fetched from the first source that has it, and must match its locked sha256:
  1. ARTIFACT_MIRROR_PREFIX/<filename>, when set
  2. the GitHub release in locks/artifact-mirrors.tsv (assets named <sha256>.deb)
  3. the locked upstream URL
  4. for Ubuntu debs, Launchpad, which keeps every published build

Environment:
  GITHUB_ARTIFACT_MIRROR_REPO  Optional GitHub repo override for release assets.
  ARTIFACT_MIRROR_TAG          Optional GitHub release tag override.
  ARTIFACT_MIRROR_PREFIX       Optional unauthenticated HTTP mirror prefix.
  ARTIFACT_MIRROR_DISABLE=1    Skip the GitHub release (used to fill a new one).
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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_file() {
  [[ "$(sha256_file "$1")" == "$2" ]]
}

# A source that is down should not hold the build up for long when another
# source can still serve the file, so only the last source retries hard.
download_with_curl() {
  local url="$1"
  local out_path="$2"
  local retries="$3"

  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --retry "$retries" \
    --retry-all-errors \
    --retry-delay 2 \
    --connect-timeout 20 \
    --max-time 1800 \
    --user-agent "minimal-vnc-desktop-artifacts/1.0" \
    --output "$out_path" \
    "$url"
}

# fetch <filename> <sha256> <out_path> <url>...: the first URL whose file
# matches the sha256 wins.
fetch() {
  local filename="$1" expected_sha="$2" out_path="$3"
  shift 3
  local tmp_path="$TMP_DOWNLOAD_DIR/$filename"
  local url retries remaining=$#

  for url in "$@"; do
    remaining=$((remaining - 1))
    retries=2
    [[ "$remaining" == "0" ]] && retries=8
    rm -f "$tmp_path"
    if download_with_curl "$url" "$tmp_path" "$retries"; then
      if verify_file "$tmp_path" "$expected_sha"; then
        mv "$tmp_path" "$out_path"
        return
      fi
      echo "Checksum mismatch for $filename from $url" >&2
    fi
    if [[ "$remaining" != "0" ]]; then
      echo "Could not get $filename from $url; trying the next source" >&2
    fi
  done

  echo "No source served $filename with sha256 $expected_sha" >&2
  exit 1
}

# prepare <lock> <dest-dir> <filename-col> <url-col> <sha-col> <launchpad:0|1>
prepare() {
  local lock="$1" dest="$2" file_col="$3" url_col="$4" sha_col="$5" launchpad="$6"
  local filename url sha urls expected=()

  mkdir -p "$dest"
  while IFS=$'\t' read -r filename url sha; do
    expected+=("$filename")
    if [[ -f "$dest/$filename" ]] && verify_file "$dest/$filename" "$sha"; then
      continue
    fi
    echo "Preparing $filename"
    urls=()
    if [[ -n "${ARTIFACT_MIRROR_PREFIX:-}" ]]; then
      urls+=("${ARTIFACT_MIRROR_PREFIX%/}/$filename")
    fi
    if [[ "${ARTIFACT_MIRROR_DISABLE:-0}" != "1" && -n "$GITHUB_ARTIFACT_MIRROR_REPO" && -n "$ARTIFACT_MIRROR_TAG" ]]; then
      urls+=("https://github.com/$GITHUB_ARTIFACT_MIRROR_REPO/releases/download/$ARTIFACT_MIRROR_TAG/$sha.deb")
    fi
    urls+=("$url")
    if [[ "$launchpad" == "1" ]]; then
      urls+=("https://launchpad.net/ubuntu/+archive/primary/+files/$filename")
    fi
    fetch "$filename" "$sha" "$dest/$filename" "${urls[@]}"
  done < <(
    awk -F '\t' -v arch="$TARGET_ARCH" -v f="$file_col" -v u="$url_col" -v s="$sha_col" \
      '$0 !~ /^[[:space:]]*(#|$)/ && $1 == arch { print $f "\t" $u "\t" $s }' "$lock"
  )

  if [[ "${#expected[@]}" == "0" ]]; then
    echo "No ${lock##*/} entries for $TARGET_ARCH" >&2
    exit 1
  fi

  # Drop debs left over from an earlier lock, so the directory holds exactly
  # the locked set and the image installs nothing else.
  local existing
  for existing in "$dest"/*.deb; do
    [[ -e "$existing" ]] || continue
    if ! printf '%s\n' "${expected[@]}" | grep -qxF "$(basename "$existing")"; then
      echo "Pruning stale artifact $(basename "$existing")"
      rm -f "$existing"
    fi
  done
}

prepare "$CHROMIUM_LOCK" "$ARTIFACT_ROOT/debs" 3 4 5 0
prepare "$APT_LOCK" "$ARTIFACT_ROOT/apt" 4 5 6 1

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
