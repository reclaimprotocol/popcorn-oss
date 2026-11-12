#!/usr/bin/env bash
# Copy every locked artifact (locks/apt-debs.tsv and locks/chromium-artifacts.tsv)
# into a GitHub release, then point locks/artifact-mirrors.tsv at it.
#
# Run it after lock-apt-debs.sh changes the lock, and commit the updated
# artifact-mirrors.tsv with the new lock. Builds then fetch every file from the
# release, so they do not depend on the Ubuntu snapshot or any other upstream.
#
# Assets are named <sha256>.deb: GitHub rewrites some characters that deb file
# names use, and a content name lets a build check what it asked for.
# The tag is derived from the locked hashes, so the same lock always maps to the
# same release, and a release is never changed after it is complete.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MIRROR_LOCK="$SCRIPT_DIR/locks/artifact-mirrors.tsv"
ARCH="${1:-amd64}"
REPO="${GITHUB_ARTIFACT_MIRROR_REPO:-reclaimprotocol/popcorn-oss}"

command -v gh >/dev/null 2>&1 || { echo "Missing required command: gh" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Fetch from upstream only: the release being filled may not exist yet.
ARTIFACT_MIRROR_DISABLE=1 "$SCRIPT_DIR/prepare-artifacts.sh" "$work/context" "linux/$ARCH"

mkdir -p "$work/assets"
locked() {
  awk -F '\t' -v arch="$ARCH" -v f="$2" -v s="$3" \
    '$0 !~ /^[[:space:]]*(#|$)/ && $1 == arch { print $f "\t" $s }' "$1"
}
while IFS=$'\t' read -r filename sha; do
  cp "$work/context/artifacts/debs/$filename" "$work/assets/$sha.deb"
done < <(locked "$SCRIPT_DIR/locks/chromium-artifacts.tsv" 3 5)
while IFS=$'\t' read -r filename sha; do
  cp "$work/context/artifacts/apt/$filename" "$work/assets/$sha.deb"
done < <(locked "$SCRIPT_DIR/locks/apt-debs.tsv" 4 6)

digest="$(cd "$work/assets" && ls | LC_ALL=C sort | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)"
tag="lock-${ARCH}-${digest}"
count="$(ls "$work/assets" | wc -l | tr -d '[:space:]')"

if ! gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$tag" --repo "$REPO" --latest=false \
    --title "Build artifact mirror ($ARCH, $digest)" \
    --notes "Pinned .deb files for images/minimal-vnc-desktop on $ARCH, named by sha256. Made by publish-artifact-mirror.sh; builds fetch from here instead of upstream archives. Do not edit."
fi

# Upload only what the release lacks, so an interrupted run can be resumed.
have="$(gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[].name')"
missing=()
for asset in "$work/assets"/*.deb; do
  printf '%s\n' "$have" | grep -qxF "$(basename "$asset")" || missing+=("$asset")
done
if [[ "${#missing[@]}" != "0" ]]; then
  gh release upload "$tag" --repo "$REPO" "${missing[@]}"
fi

have_count="$(gh release view "$tag" --repo "$REPO" --json assets --jq '.assets | length')"
if [[ "$have_count" != "$count" ]]; then
  echo "Release $tag has $have_count assets, expected $count" >&2
  exit 1
fi

awk -F '\t' -v OFS='\t' -v arch="$ARCH" -v repo="$REPO" -v tag="$tag" '
  $0 !~ /^[[:space:]]*(#|$)/ && $1 == arch { print arch, repo, tag; done = 1; next }
  { print }
  END { if (!done) print arch, repo, tag }
' "$MIRROR_LOCK" >"$work/mirrors.tsv"
cp "$work/mirrors.tsv" "$MIRROR_LOCK"
echo "Mirrored $count artifacts to $REPO release $tag"
