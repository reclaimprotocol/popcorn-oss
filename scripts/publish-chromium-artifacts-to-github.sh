#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
LOCK_FILE="$REPO_ROOT/popcorn-images/images/chromium-headful/chromium-lock.json"

usage() {
  cat <<'EOF'
Usage:
  scripts/publish-chromium-artifacts-to-github.sh <owner/repo>

Environment:
  GITHUB_ARTIFACT_MIRROR_REPO  Default repo if no positional arg is given.
  PLATFORM                     Optional platform override, e.g. linux/amd64 or linux/arm64.

This script:
  1. Computes the current deterministic artifact mirror tag from chromium-lock.json.
  2. Downloads the locked Chromium headful build artifacts for the selected arch.
  3. Verifies SHA256 checksums.
  4. Uploads them to a GitHub release named after that tag.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

MIRROR_REPO="${1:-${GITHUB_ARTIFACT_MIRROR_REPO:-}}"
if [[ -z "$MIRROR_REPO" ]]; then
  usage >&2
  exit 1
fi

for cmd in gh curl python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

eval "$("$SCRIPT_DIR/chromium-lock-env.sh" "${PLATFORM:-}")"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

ARTIFACT_LIST_FILE="$TMP_DIR/artifacts.tsv"

python3 - "$LOCK_FILE" "$TARGET_ARCH" >"$ARTIFACT_LIST_FILE" <<'PY'
import json
import pathlib
import sys

lock_path = pathlib.Path(sys.argv[1])
target_arch = sys.argv[2]
lock = json.loads(lock_path.read_text())

chromium_packages = lock["chromium"]["packages"][target_arch]
libxcvt_package = lock["libxcvt0"]["packages"][target_arch]
ffmpeg_archive = lock["ffmpeg"]["archives"][target_arch]
websocat_binary = lock["websocat"]["binaries"][target_arch]

artifacts = [
    *chromium_packages,
    libxcvt_package,
    ffmpeg_archive,
    websocat_binary,
]

for artifact in artifacts:
    print(f'{artifact["filename"]}\t{artifact["url"]}\t{artifact["sha256"]}')
PY

declare -A ARTIFACT_URLS=()
declare -A ARTIFACT_SHAS=()
expected_assets=()
while IFS=$'\t' read -r filename url sha256; do
  expected_assets+=("$filename")
  ARTIFACT_URLS["$filename"]="$url"
  ARTIFACT_SHAS["$filename"]="$sha256"
done <"$ARTIFACT_LIST_FILE"

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

download_from_github_release() {
  local filename="$1"
  local out_path="$2"

  rm -f "$TMP_DIR/$filename"
  if gh release download "$ARTIFACT_MIRROR_TAG" \
    --repo "$MIRROR_REPO" \
    --pattern "$filename" \
    --dir "$TMP_DIR" \
    --clobber >/dev/null; then
    if [[ -f "$TMP_DIR/$filename" ]]; then
      mv "$TMP_DIR/$filename" "$out_path"
      return 0
    fi
  fi

  return 1
}

echo "Publishing Chromium artifacts for $TARGET_ARCH to $MIRROR_REPO"
echo "Release tag: $ARTIFACT_MIRROR_TAG"

declare -A RELEASE_ASSET_LOOKUP=()
if gh release view "$ARTIFACT_MIRROR_TAG" --repo "$MIRROR_REPO" >/dev/null 2>&1; then
  while IFS= read -r asset_name; do
    RELEASE_ASSET_LOOKUP["$asset_name"]=1
  done < <(
    gh release view "$ARTIFACT_MIRROR_TAG" \
      --repo "$MIRROR_REPO" \
      --json assets \
      --jq '.assets[].name'
  )
fi

release_exists=false
if gh release view "$ARTIFACT_MIRROR_TAG" --repo "$MIRROR_REPO" >/dev/null 2>&1; then
  release_exists=true

  missing_assets=()
  for asset_name in "${expected_assets[@]}"; do
    if [[ -z "${RELEASE_ASSET_LOOKUP[$asset_name]+x}" ]]; then
      missing_assets+=("$asset_name")
    fi
  done

  if [[ "${#missing_assets[@]}" -eq 0 ]]; then
    echo "Release $ARTIFACT_MIRROR_TAG already contains all expected assets for $TARGET_ARCH."
  else
    echo "Release $ARTIFACT_MIRROR_TAG is missing ${#missing_assets[@]} asset(s); refreshing release assets."
  fi
else
  echo "Release $ARTIFACT_MIRROR_TAG is not present. Publishing all artifacts."
fi

downloaded_files=()
for filename in "${expected_assets[@]}"; do
  out_path="$TMP_DIR/$filename"
  expected_sha="${ARTIFACT_SHAS[$filename]}"
  upstream_url="${ARTIFACT_URLS[$filename]}"
  used_mirror=false

  if [[ "$release_exists" == true ]] && [[ -n "${RELEASE_ASSET_LOOKUP[$filename]+x}" ]]; then
    echo "Using already-mirrored $filename from release"
    if download_from_github_release "$filename" "$out_path"; then
      used_mirror=true
    else
      echo "GitHub mirror download failed for $filename; falling back to upstream" >&2
    fi
  fi

  if [[ "$used_mirror" != true ]]; then
    echo "Downloading $filename"
    download_with_curl "$upstream_url" "$out_path"
  fi

  actual_sha="$(sha256_file "$out_path")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "Checksum mismatch for $filename" >&2
    echo "Expected: $expected_sha" >&2
    echo "Actual:   $actual_sha" >&2
    exit 1
  fi

  downloaded_files+=("$out_path")
done

if ! $release_exists; then
  gh release create "$ARTIFACT_MIRROR_TAG" \
    --repo "$MIRROR_REPO" \
    --title "$ARTIFACT_MIRROR_TAG" \
    --notes "Mirrored Chromium headful build artifacts for ${TARGET_ARCH} from chromium-lock.json."
fi

gh release upload "$ARTIFACT_MIRROR_TAG" \
  --repo "$MIRROR_REPO" \
  --clobber \
  "${downloaded_files[@]}"

declare -A RELEASE_ASSETS=()
while IFS= read -r asset_name; do
  RELEASE_ASSETS["$asset_name"]=1
done < <(
  gh release view "$ARTIFACT_MIRROR_TAG" \
    --repo "$MIRROR_REPO" \
    --json assets \
    --jq '.assets[].name'
)

if [[ "${#RELEASE_ASSETS[@]}" -ne "${#expected_assets[@]}" ]]; then
  echo "Release completeness check failed: expected ${#expected_assets[@]} asset(s), found ${#RELEASE_ASSETS[@]} artifact(s)" >&2
  for asset_name in "${!RELEASE_ASSETS[@]}"; do
    echo "Uploaded asset: $asset_name"
  done | sort
  exit 1
fi

for expected_asset in "${expected_assets[@]}"; do
  if [[ -z "${RELEASE_ASSETS[$expected_asset]+x}" ]]; then
    echo "Release completeness check failed: missing asset '$expected_asset' in $ARTIFACT_MIRROR_TAG" >&2
    exit 1
  fi
done

for uploaded_asset in "${!RELEASE_ASSETS[@]}"; do
  if [[ -z "${ARTIFACT_SHAS[$uploaded_asset]+x}" ]]; then
    echo "Release completeness check failed: unexpected asset '$uploaded_asset' in $ARTIFACT_MIRROR_TAG" >&2
    exit 1
  fi
done

cat <<EOF

GitHub mirror is ready.

Use it in builds with:
  export GITHUB_ARTIFACT_MIRROR_REPO=$MIRROR_REPO
  make build-base

Or for the image script:
  export GITHUB_ARTIFACT_MIRROR_REPO=$MIRROR_REPO
  cd popcorn-images/images/chromium-headful
  IMAGE=kernel-docker ./build-docker.sh
EOF
