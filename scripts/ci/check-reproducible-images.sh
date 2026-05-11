#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

usage() {
  cat <<'EOF'
Usage:
  scripts/ci/check-reproducible-images.sh --commit-sha <sha> [--service all|browser-runtime-attestor|browser-runtime|browser-base]

Pulls the published immutable image tag for the selected reproducible image set,
rebuilds that image locally from the same commit, and compares the resulting
image config digest with the published image config digest.
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
  all|browser-runtime-attestor|browser-runtime|browser-base) ;;
  attestor)
    selector="browser-runtime-attestor"
    ;;
  browser-node)
    selector="browser-runtime"
    ;;
  *)
    echo "Unknown service selector: $selector" >&2
    usage >&2
    exit 1
    ;;
esac

for cmd in curl docker gh git python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

cd "$REPO_ROOT"

mkdir -p dist

REGISTRY_HOST="${REGISTRY_HOST:-ghcr.io}"
REGISTRY_PROJECT_ID="${REGISTRY_PROJECT_ID:-reclaimprotocol}"
REGISTRY_REPOSITORY="${REGISTRY_REPOSITORY:-popcorn-images}"

requested_commit="$(git rev-parse "${commit_sha}^{commit}")"
current_commit="$(git rev-parse HEAD)"
if [[ "$requested_commit" != "$current_commit" ]]; then
  echo "Current checkout (${current_commit}) does not match requested commit (${requested_commit})" >&2
  exit 1
fi

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --pretty=%ct)}"
SUBMODULE_SHA="$(git submodule status popcorn-images | awk '{print $1}' | sed 's/^+//')"
SUBMODULE_SOURCE_DATE_EPOCH="$(git -C popcorn-images log -1 --pretty=%ct)"

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

pull_published_image() {
  local service="$1"
  local image_tag="${2:-$requested_commit}"
  local image_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/${service}:${image_tag}"

  echo "Pulling published image ${image_ref}..." >&2
  docker pull --platform linux/amd64 "$image_ref" >/dev/null
  published_config_digest_from_pull "$image_ref" "${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/${service}"
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
    --output "type=oci,dest=${out_dir},tar=false,name=local/popcorn/browser-runtime-attestor:${requested_commit}" \
    services/attestor

  attestor_local="$(config_digest_from_metadata "$metadata_file")"
  rm -f "$metadata_file"
}

build_browser_base_once() {
  local artifact_layout_dir base_layout_dir
  local base_metadata_file

  eval "$("$SCRIPT_DIR/../chromium-lock-env.sh" linux/amd64)"

  artifact_layout_dir="$(mktemp -d)"
  base_layout_dir="$(mktemp -d)"
  base_metadata_file="$(mktemp)"
  CLEANUP_DIRS+=("$artifact_layout_dir" "$base_layout_dir")
  browser_base_local_layout_dir="$base_layout_dir"

  SOURCE_DATE_EPOCH=0 "$SCRIPT_DIR/../prepare-chromium-artifacts.sh" "$artifact_layout_dir" linux/amd64

  docker buildx build \
    --platform linux/amd64 \
    --build-arg "SOURCE_DATE_EPOCH=${SUBMODULE_SOURCE_DATE_EPOCH}" \
    --build-arg "UBUNTU_SNAPSHOT=${UBUNTU_SNAPSHOT}" \
    --build-arg "ARTIFACT_MIRROR_IMAGE=artifact-mirror" \
    --build-context "artifact-mirror=${artifact_layout_dir}" \
    --metadata-file "$base_metadata_file" \
    --output "type=oci,dest=${base_layout_dir},tar=false,name=local/popcorn/browser-base:${SUBMODULE_SHA}-${requested_commit}" \
    -f popcorn-images/images/chromium-headful/Dockerfile \
    popcorn-images

  browser_base_local="$(config_digest_from_metadata "$base_metadata_file")"
  rm -f "$base_metadata_file"
}

resolve_published_browser_base_digest() {
  local image_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/browser-base:${SUBMODULE_SHA}"

  if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcloud is required to resolve the published browser-base digest for browser-runtime verification" >&2
    exit 1
  fi

  gcloud artifacts docker images describe "$image_ref" \
    --format='value(image_summary.digest)'
}

build_browser_node_once() {
  local metadata_file out_dir browser_base_digest browser_base_ref

  metadata_file="$(mktemp)"
  out_dir="$(mktemp -d)"
  CLEANUP_DIRS+=("$out_dir")
  browser_node_local_layout_dir="$out_dir"

  browser_base_digest="$(resolve_published_browser_base_digest)"
  if [[ -z "$browser_base_digest" ]]; then
    echo "Failed to resolve published browser-base digest for ${SUBMODULE_SHA}" >&2
    exit 1
  fi
  browser_base_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/browser-base@${browser_base_digest}"

  docker buildx build \
    --platform linux/amd64 \
    --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
    --build-arg "BASE_IMAGE=${browser_base_ref}" \
    --metadata-file "$metadata_file" \
    --output "type=oci,dest=${out_dir},tar=false,name=local/popcorn/browser-runtime:${requested_commit}" \
    services/browser-node

  browser_node_local="$(config_digest_from_metadata "$metadata_file")"
  rm -f "$metadata_file"
}

services=()
if [[ "$selector" == "all" ]]; then
  services=(browser-runtime-attestor browser-base browser-runtime)
else
  services=("$selector")
fi

attestor_published=""
attestor_local=""
attestor_published_ref=""
attestor_local_layout_dir=""
browser_base_published=""
browser_base_local=""
browser_base_published_ref=""
browser_base_local_layout_dir=""
browser_node_published=""
browser_node_local=""
browser_node_published_ref=""
browser_node_local_layout_dir=""
artifact_mirror_tag=""

for service in "${services[@]}"; do
  case "$service" in
    browser-runtime-attestor)
      echo "Comparing published and local browser-runtime-attestor digests..."
      attestor_published_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/browser-runtime-attestor:${requested_commit}"
      attestor_published="$(pull_published_image browser-runtime-attestor)"
      build_attestor_once
      ;;
    browser-base)
      echo "Comparing published and local browser-base digests..."
      eval "$("$SCRIPT_DIR/../chromium-lock-env.sh" linux/amd64)"
      artifact_mirror_tag="$ARTIFACT_MIRROR_TAG"
      browser_base_published_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/browser-base:${SUBMODULE_SHA}"
      browser_base_published="$(pull_published_image browser-base "$SUBMODULE_SHA")"
      build_browser_base_once
      ;;
    browser-runtime)
      echo "Comparing published and local browser-runtime digests..."
      eval "$("$SCRIPT_DIR/../chromium-lock-env.sh" linux/amd64)"
      artifact_mirror_tag="$ARTIFACT_MIRROR_TAG"
      browser_node_published_ref="${REGISTRY_HOST}/${REGISTRY_PROJECT_ID}/${REGISTRY_REPOSITORY}/browser-runtime:${requested_commit}"
      browser_node_published="$(pull_published_image browser-runtime)"
      build_browser_node_once
      ;;
  esac
done

python3 - "$selector" "$SOURCE_DATE_EPOCH" "$SUBMODULE_SHA" "$artifact_mirror_tag" \
  "$requested_commit" "$attestor_published" "$attestor_local" "$browser_base_published" "$browser_base_local" \
  "$browser_node_published" "$browser_node_local" <<'PY'
from __future__ import annotations

import json
import pathlib
import sys

selector, source_date_epoch, submodule_sha, artifact_mirror_tag, commit_sha, att_published, att_local, base_published, base_local, browser_published, browser_local = sys.argv[1:]
source_date_epoch = int(source_date_epoch)

results = {}

if selector in {"all", "browser-runtime-attestor"}:
    results["browser-runtime-attestor"] = {
        "published_config_digest": att_published,
        "local_config_digest": att_local,
        "match": bool(att_published) and att_published == att_local,
    }

if selector in {"all", "browser-base"}:
    results["browser-base"] = {
        "published_config_digest": base_published,
        "local_config_digest": base_local,
        "match": bool(base_published) and base_published == base_local,
        "submodule_sha": submodule_sha,
        "artifact_mirror_tag": artifact_mirror_tag,
    }

if selector in {"all", "browser-runtime"}:
    results["browser-runtime"] = {
        "published_config_digest": browser_published,
        "local_config_digest": browser_local,
        "match": bool(browser_published) and browser_published == browser_local,
        "submodule_sha": submodule_sha,
        "artifact_mirror_tag": artifact_mirror_tag,
    }

payload = {
    "commit_sha": commit_sha,
    "source_date_epoch": source_date_epoch,
    "registry_policy": "immutable tags; verification compares published image config digests with local rebuilds",
    "results": results,
}

json_path = pathlib.Path("dist/reproducible-images-check.json")
markdown_path = pathlib.Path("dist/reproducible-images-check.md")
json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

lines = [
    "## Reproducible Image Verification",
    "",
    "This check pulls the published immutable image for the requested commit, rebuilds locally from the same commit, and compares the resulting image config digests.",
    "",
    f"Commit SHA: `{commit_sha}`",
    f"Source date epoch: `{source_date_epoch}`",
    "Registry policy: immutable tags; verification compares published image config digests with local rebuilds",
    "",
    "| Image | Published config | Local rebuild config | Match |",
    "| --- | --- | --- | --- |",
]

for image_name, result in results.items():
    match = "yes" if result["match"] else "no"
    lines.append(
        f"| `{image_name}` | `{result['published_config_digest']}` | `{result['local_config_digest']}` | `{match}` |"
    )

if "browser-base" in results:
    lines.extend(
        [
            "",
            f"Browser-base submodule SHA: `{results['browser-base']['submodule_sha']}`",
            f"Chromium artifact mirror tag: `{results['browser-base']['artifact_mirror_tag']}`",
        ]
    )

if "browser-runtime" in results:
    lines.extend(
        [
            "",
            f"Browser runtime submodule SHA: `{results['browser-runtime']['submodule_sha']}`",
            f"Chromium artifact mirror tag: `{results['browser-runtime']['artifact_mirror_tag']}`",
        ]
    )

markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
PY

check_failed=0

if [[ -n "$attestor_published" && "$attestor_published" != "$attestor_local" ]]; then
  check_failed=1
  if [[ -n "$attestor_published_ref" && -n "$attestor_local_layout_dir" ]]; then
    python3 "$SCRIPT_DIR/diff-image-layers.py" \
      --service browser-runtime-attestor \
      --published-image-ref "$attestor_published_ref" \
      --local-oci-layout "$attestor_local_layout_dir" \
      --output-json "dist/reproducible-image-layer-diff-browser-runtime-attestor.json" \
      --output-md "dist/reproducible-image-layer-diff-browser-runtime-attestor.md"
  fi
fi

if [[ -n "$browser_base_published" && "$browser_base_published" != "$browser_base_local" ]]; then
  check_failed=1
  if [[ -n "$browser_base_published_ref" && -n "$browser_base_local_layout_dir" ]]; then
    python3 "$SCRIPT_DIR/diff-image-layers.py" \
      --service browser-base \
      --published-image-ref "$browser_base_published_ref" \
      --local-oci-layout "$browser_base_local_layout_dir" \
      --output-json "dist/reproducible-image-layer-diff-browser-base.json" \
      --output-md "dist/reproducible-image-layer-diff-browser-base.md"
  fi
fi

if [[ -n "$browser_node_published" && "$browser_node_published" != "$browser_node_local" ]]; then
  check_failed=1
  if [[ -n "$browser_node_published_ref" && -n "$browser_node_local_layout_dir" ]]; then
    python3 "$SCRIPT_DIR/diff-image-layers.py" \
      --service browser-runtime \
      --published-image-ref "$browser_node_published_ref" \
      --local-oci-layout "$browser_node_local_layout_dir" \
      --output-json "dist/reproducible-image-layer-diff-browser-runtime.json" \
      --output-md "dist/reproducible-image-layer-diff-browser-runtime.md"
  fi
fi

if (( check_failed )); then
  echo >&2
  echo "Reproducibility check failed for:" >&2
  if [[ -n "$attestor_published" && "$attestor_published" != "$attestor_local" ]]; then
    echo "  - browser-runtime-attestor: published=${attestor_published} local=${attestor_local}" >&2
  fi
  if [[ -n "$browser_base_published" && "$browser_base_published" != "$browser_base_local" ]]; then
    echo "  - browser-base: published=${browser_base_published} local=${browser_base_local}" >&2
  fi
  if [[ -n "$browser_node_published" && "$browser_node_published" != "$browser_node_local" ]]; then
    echo "  - browser-runtime: published=${browser_node_published} local=${browser_node_local}" >&2
  fi
  exit 1
fi
