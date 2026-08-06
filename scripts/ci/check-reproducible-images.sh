#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

usage() {
  cat <<'EOF'
Usage:
  scripts/ci/check-reproducible-images.sh --commit-sha <sha> [--service all|browser-runtime-attestor|browser-runtime]

Pulls the published immutable image tag for the selected reproducible image set,
rebuilds that image locally from the same commit, and compares both the image
config digest and the complete registry manifest digest.
EOF
}

selector="all"
commit_sha=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit-sha)
      commit_sha="${2:-}"
      shift 2
      ;;
    --service)
      selector="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$commit_sha" ]]; then
  echo "--commit-sha is required" >&2
  usage >&2
  exit 1
fi

case "$selector" in
  all|browser-runtime-attestor|browser-runtime) ;;
  attestor)
    selector="browser-runtime-attestor"
    ;;
  *)
    echo "Unknown service selector: $selector" >&2
    usage >&2
    exit 1
    ;;
esac

for cmd in curl docker git python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

cd "$REPO_ROOT"

mkdir -p dist

REGISTRY_HOST="${REGISTRY_HOST:-ghcr.io}"
REGISTRY_PROJECT_ID="${REGISTRY_PROJECT_ID:-reclaimprotocol}"
REGISTRY_REPOSITORY="${REGISTRY_REPOSITORY:-popcorn-oss}"

requested_commit="$(git rev-parse "${commit_sha}^{commit}")"
current_commit="$(git rev-parse HEAD)"
if [[ "$requested_commit" != "$current_commit" ]]; then
  echo "Current checkout (${current_commit}) does not match requested commit (${requested_commit})" >&2
  exit 1
fi

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --pretty=%ct)}"
export SOURCE_DATE_EPOCH

declare -a CLEANUP_TARGETS=()
declare -a CLEANUP_DIRS=()

ensure_cosign_pub() {
  local service_dir="$1"
  local target="$service_dir/cosign.pub"

  if [[ ! -e "$target" ]]; then
    CLEANUP_TARGETS+=("$target")
  fi
  cp -f cosign.pub "$target"
}

cleanup() {
  local path
  for path in "${CLEANUP_TARGETS[@]:-}"; do
    rm -f "$path"
  done
  for path in "${CLEANUP_DIRS[@]:-}"; do
    rm -rf "$path"
  done
}
trap cleanup EXIT

metadata_value() {
  python3 - "$1" "$2" <<'PY'
import json
import pathlib
import sys

metadata = json.loads(pathlib.Path(sys.argv[1]).read_text())
key = sys.argv[2]
digest = metadata.get(key)
if not digest:
    raise SystemExit(f"{key} missing from metadata")
print(digest)
PY
}

config_digest_from_metadata() {
  metadata_value "$1" "containerimage.config.digest"
}

published_config_digest_from_pull() {
  python3 - "$1" "$2" <<'PY'
import json
import subprocess
import sys

image_ref = sys.argv[1]
repo_prefix = sys.argv[2]
image_id = subprocess.check_output(
    ["docker", "image", "inspect", image_ref, "--format", "{{.Id}}"],
    text=True,
).strip()
if not image_id.startswith("sha256:"):
    raise SystemExit(f"Unexpected image config digest for {image_ref}: {image_id}")

repo_digests = json.loads(
    subprocess.check_output(
        ["docker", "image", "inspect", image_ref, "--format", "{{json .RepoDigests}}"],
        text=True,
    )
)
if not any(value.startswith(repo_prefix + "@") for value in repo_digests):
    raise SystemExit(f"Could not find repo digest for {image_ref}")

print(image_id)
PY
}

published_repo_digest_from_pull() {
  python3 - "$1" "$2" <<'PY'
import json
import subprocess
import sys

image_ref = sys.argv[1]
repo_prefix = sys.argv[2]
repo_digests = json.loads(
    subprocess.check_output(
        ["docker", "image", "inspect", image_ref, "--format", "{{json .RepoDigests}}"],
        text=True,
    )
)
for value in repo_digests:
    if value.startswith(repo_prefix + "@"):
        print(value.split("@", 1)[1])
        raise SystemExit(0)
raise SystemExit(f"Could not find repo digest for {image_ref}")
PY
}

pull_published_image() {
  local service="$1"
  local image_tag="${2:-$requested_commit}"
  local image_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/${service}:${image_tag}"

  echo "Pulling published image ${image_ref}..." >&2
  docker pull --platform linux/amd64 "$image_ref" >/dev/null
  published_config_digest_from_pull "$image_ref" "${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/${service}"
}

pull_published_repo_digest() {
  local service="$1"
  local image_tag="${2:-$requested_commit}"
  local image_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/${service}:${image_tag}"
  local repo_prefix="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/${service}"

  echo "Pulling published image ${image_ref}..." >&2
  docker pull --platform linux/amd64 "$image_ref" >/dev/null
  published_repo_digest_from_pull "$image_ref" "$repo_prefix"
}

build_attestor_once() {
  local metadata_file out_dir

  ensure_cosign_pub "services/attestor"
  metadata_file="$(mktemp)"
  out_dir="$(mktemp -d)"
  CLEANUP_DIRS+=("$out_dir")
  attestor_local_layout_dir="$out_dir"

  docker buildx build \
    --platform linux/amd64 \
    --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
    --metadata-file "$metadata_file" \
    --provenance=false \
    --output "type=oci,dest=${out_dir},tar=false,name=local/popcorn/browser-runtime-attestor:${requested_commit},oci-mediatypes=true,compression=gzip,compression-level=9,force-compression=true,rewrite-timestamp=true" \
    services/attestor

  attestor_local="$(config_digest_from_metadata "$metadata_file")"
  attestor_local_manifest="$(metadata_value "$metadata_file" "containerimage.digest")"
  rm -f "$metadata_file"
}

build_browser_runtime_once() {
  local metadata_file out_dir artifact_dir ubuntu_snapshot

  metadata_file="$(mktemp)"
  out_dir="$(mktemp -d)"
  artifact_dir="$(mktemp -d)"
  CLEANUP_DIRS+=("$out_dir" "$artifact_dir")
  browser_runtime_local_layout_dir="$out_dir"

  ubuntu_snapshot="$(awk -F '=' '$1 == "UBUNTU_SNAPSHOT" { print $2 }' images/minimal-vnc-desktop/locks/ubuntu-snapshot.lock)"
  if [[ -z "$ubuntu_snapshot" ]]; then
    echo "Failed to resolve UBUNTU_SNAPSHOT from images/minimal-vnc-desktop/locks/ubuntu-snapshot.lock" >&2
    exit 1
  fi

  GITHUB_ARTIFACT_MIRROR_REPO="${GITHUB_ARTIFACT_MIRROR_REPO:-reclaimprotocol/popcorn-oss}" \
    SOURCE_DATE_EPOCH=0 ./images/minimal-vnc-desktop/prepare-artifacts.sh "$artifact_dir" linux/amd64

  docker buildx build \
    --platform linux/amd64 \
    --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
    --build-arg "UBUNTU_SNAPSHOT=${ubuntu_snapshot}" \
    --build-context "minimal-vnc-artifacts=${artifact_dir}" \
    --metadata-file "$metadata_file" \
    --provenance=false \
    --output "type=oci,dest=${out_dir},tar=false,name=local/popcorn/browser-runtime:${requested_commit},oci-mediatypes=true,compression=gzip,compression-level=9,force-compression=true,rewrite-timestamp=true" \
    images/minimal-vnc-desktop

  browser_runtime_local="$(config_digest_from_metadata "$metadata_file")"
  browser_runtime_local_manifest="$(metadata_value "$metadata_file" "containerimage.digest")"
  rm -f "$metadata_file"
}

services=()
if [[ "$selector" == "all" ]]; then
  services=(browser-runtime-attestor browser-runtime)
else
  services=("$selector")
fi

attestor_published=""
attestor_local=""
attestor_published_manifest=""
attestor_local_manifest=""
attestor_published_ref=""
attestor_local_layout_dir=""
browser_runtime_published=""
browser_runtime_local=""
browser_runtime_published_manifest=""
browser_runtime_local_manifest=""
browser_runtime_published_ref=""
browser_runtime_local_layout_dir=""

for service in "${services[@]}"; do
  case "$service" in
    browser-runtime-attestor)
      echo "Comparing published and local browser-runtime-attestor digests..."
      attestor_published_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/browser-runtime-attestor:${requested_commit}"
      attestor_published="$(pull_published_image browser-runtime-attestor)"
      attestor_published_manifest="$(pull_published_repo_digest browser-runtime-attestor)"
      build_attestor_once
      ;;
    browser-runtime)
      echo "Comparing published and local browser-runtime digests..."
      browser_runtime_published_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/browser-runtime:${requested_commit}"
      browser_runtime_published="$(pull_published_image browser-runtime)"
      browser_runtime_published_manifest="$(pull_published_repo_digest browser-runtime)"
      build_browser_runtime_once
      ;;
  esac
done

python3 - "$selector" "$SOURCE_DATE_EPOCH" "$requested_commit" \
  "$attestor_published" "$attestor_local" \
  "$attestor_published_manifest" "$attestor_local_manifest" \
  "$browser_runtime_published" "$browser_runtime_local" \
  "$browser_runtime_published_manifest" "$browser_runtime_local_manifest" <<'PY'
from __future__ import annotations

import json
import pathlib
import sys

(
    selector,
    source_date_epoch,
    commit_sha,
    att_published,
    att_local,
    att_published_manifest,
    att_local_manifest,
    browser_published,
    browser_local,
    browser_published_manifest,
    browser_local_manifest,
) = sys.argv[1:]
source_date_epoch = int(source_date_epoch)

results = {}

if selector in {"all", "browser-runtime-attestor"}:
    results["browser-runtime-attestor"] = {
        "published_config_digest": att_published,
        "local_config_digest": att_local,
        "config_match": bool(att_published) and att_published == att_local,
        "published_manifest_digest": att_published_manifest,
        "local_manifest_digest": att_local_manifest,
        "manifest_match": bool(att_published_manifest)
        and att_published_manifest == att_local_manifest,
    }

if selector in {"all", "browser-runtime"}:
    results["browser-runtime"] = {
        "published_config_digest": browser_published,
        "local_config_digest": browser_local,
        "config_match": bool(browser_published) and browser_published == browser_local,
        "published_manifest_digest": browser_published_manifest,
        "local_manifest_digest": browser_local_manifest,
        "manifest_match": bool(browser_published_manifest)
        and browser_published_manifest == browser_local_manifest,
    }

for result in results.values():
    result["match"] = result["config_match"] and result["manifest_match"]

payload = {
    "commit_sha": commit_sha,
    "source_date_epoch": source_date_epoch,
    "registry_policy": "immutable tags; verification compares config and registry manifest digests with local rebuilds",
    "results": results,
}

json_path = pathlib.Path("dist/reproducible-images-check.json")
markdown_path = pathlib.Path("dist/reproducible-images-check.md")
json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

lines = [
    "## Reproducible Image Verification",
    "",
    "This check pulls the published immutable image for the requested commit, rebuilds locally from the same commit, and compares config and registry manifest digests.",
    "",
    f"Commit SHA: `{commit_sha}`",
    f"Source date epoch: `{source_date_epoch}`",
    "Registry policy: immutable tags; verification compares config and registry manifest digests with local rebuilds",
    "",
    "| Image | Config match | Manifest match | Overall |",
    "| --- | --- | --- | --- |",
]

for image_name, result in results.items():
    config_match = "yes" if result["config_match"] else "no"
    manifest_match = "yes" if result["manifest_match"] else "no"
    overall_match = "yes" if result["match"] else "no"
    lines.append(
        f"| `{image_name}` | `{config_match}` | `{manifest_match}` | `{overall_match}` |"
    )

lines.append("")

for image_name, result in results.items():
    lines.extend(
        [
            f"### `{image_name}` digests",
            "",
            f"  - Published config: `{result['published_config_digest']}`",
            f"  - Local config: `{result['local_config_digest']}`",
            f"  - Published manifest: `{result['published_manifest_digest']}`",
            f"  - Local manifest: `{result['local_manifest_digest']}`",
            "",
        ]
    )

markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
PY

check_failed=0

if [[ -n "$attestor_published" ]] \
  && { [[ "$attestor_published" != "$attestor_local" ]] \
    || [[ "$attestor_published_manifest" != "$attestor_local_manifest" ]]; }; then
  check_failed=1
  if [[ "$attestor_published" != "$attestor_local" ]] \
    && [[ -n "$attestor_published_ref" && -n "$attestor_local_layout_dir" ]]; then
    python3 "$SCRIPT_DIR/diff-image-layers.py" \
      --service browser-runtime-attestor \
      --published-image-ref "$attestor_published_ref" \
      --local-oci-layout "$attestor_local_layout_dir" \
      --output-json "dist/reproducible-image-layer-diff-browser-runtime-attestor.json" \
      --output-md "dist/reproducible-image-layer-diff-browser-runtime-attestor.md"
  fi
fi

if [[ -n "$browser_runtime_published" ]] \
  && { [[ "$browser_runtime_published" != "$browser_runtime_local" ]] \
    || [[ "$browser_runtime_published_manifest" != "$browser_runtime_local_manifest" ]]; }; then
  check_failed=1
  if [[ "$browser_runtime_published" != "$browser_runtime_local" ]] \
    && [[ -n "$browser_runtime_published_ref" && -n "$browser_runtime_local_layout_dir" ]]; then
    python3 "$SCRIPT_DIR/diff-image-layers.py" \
      --service browser-runtime \
      --published-image-ref "$browser_runtime_published_ref" \
      --local-oci-layout "$browser_runtime_local_layout_dir" \
      --output-json "dist/reproducible-image-layer-diff-browser-runtime.json" \
      --output-md "dist/reproducible-image-layer-diff-browser-runtime.md"
  fi
fi

if (( check_failed )); then
  echo >&2
  echo "Reproducibility check failed for:" >&2
  if [[ -n "$attestor_published" ]] \
    && { [[ "$attestor_published" != "$attestor_local" ]] \
      || [[ "$attestor_published_manifest" != "$attestor_local_manifest" ]]; }; then
    echo "  - browser-runtime-attestor:" >&2
    echo "      config: published=${attestor_published} local=${attestor_local}" >&2
    echo "      manifest: published=${attestor_published_manifest} local=${attestor_local_manifest}" >&2
  fi
  if [[ -n "$browser_runtime_published" ]] \
    && { [[ "$browser_runtime_published" != "$browser_runtime_local" ]] \
      || [[ "$browser_runtime_published_manifest" != "$browser_runtime_local_manifest" ]]; }; then
    echo "  - browser-runtime:" >&2
    echo "      config: published=${browser_runtime_published} local=${browser_runtime_local}" >&2
    echo "      manifest: published=${browser_runtime_published_manifest} local=${browser_runtime_local_manifest}" >&2
  fi
  exit 1
fi
