#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

IMAGE="${IMAGE:-popcorn/minimal-vnc-desktop:local}"
PLATFORM="${PLATFORM:-}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$REPO_ROOT" log -1 --pretty=%ct)}"
UBUNTU_SNAPSHOT="${UBUNTU_SNAPSHOT:-$(awk -F '=' '$1 == "UBUNTU_SNAPSHOT" { print $2 }' "$SCRIPT_DIR/locks/ubuntu-snapshot.lock")}"

# Fortress (the browser engine) is amd64-only, so the image is ALWAYS amd64 —
# an arm64 host builds it under emulation. Defaulting to the host arch here
# silently produced an arm64 image that tunnel.sh (amd64-pinned) then couldn't
# run. Pin amd64; override PLATFORM only if you truly know what you're doing.
if [[ -z "$PLATFORM" ]]; then
  PLATFORM=linux/amd64
fi

"$SCRIPT_DIR/prepare-artifacts.sh" \
  "${MINIMAL_VNC_ARTIFACT_CONTEXT:-$HOME/.cache/popcorn/minimal-vnc-desktop/${PLATFORM#linux/}}" \
  "$PLATFORM"

ARTIFACT_CONTEXT="${MINIMAL_VNC_ARTIFACT_CONTEXT:-$HOME/.cache/popcorn/minimal-vnc-desktop/${PLATFORM#linux/}}"

docker buildx build \
  --platform "$PLATFORM" \
  --build-context "minimal-vnc-artifacts=$ARTIFACT_CONTEXT" \
  --build-context "trusted-liveview=$REPO_ROOT/packages/trusted-liveview" \
  --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
  --build-arg "UBUNTU_SNAPSHOT=$UBUNTU_SNAPSHOT" \
  ${FORTRESS_IMAGE:+--build-arg "FORTRESS_IMAGE=$FORTRESS_IMAGE"} \
  -t "$IMAGE" \
  --load \
  "$SCRIPT_DIR"
