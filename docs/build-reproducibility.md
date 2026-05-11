# Build Reproducibility

The repo currently makes a reproducibility claim for `browser-runtime-attestor` and `browser-runtime` only.

## What The Repo Shows

- `.github/workflows/image-build.yaml` pushes immutable `<commit-sha>` tags and records the resolved digests for `browser-runtime-attestor`, `browser-runtime`, and `browser-base`.
- The workflow uploads a `reproducible-images-<commit-sha>` artifact and writes the same digest refs into the job summary.
- `.github/workflows/verify-reproducible-images.yaml` takes a commit SHA, pulls the published immutable image tag for `browser-runtime-attestor` and/or `browser-runtime`, rebuilds locally from that same commit, and compares the resulting OCI digests. This avoids colliding with registry tag immutability.

## Current Reproducible Scope

- `browser-runtime-attestor`
- `browser-runtime`

Everything else should still be treated as best-effort until it gets the same pinned-input treatment.

## Mirrored Inputs We Already Use

For `browser-runtime`, the `popcorn-images` submodule already locks and mirrors the large Chromium-related artifacts behind a deterministic release tag derived from `popcorn-images/images/chromium-headful/chromium-lock.json`.

The mirrored artifact set currently includes:

- Chromium `.deb` packages from the xtradeb PPA
- `libxcvt0`
- FFmpeg archive
- `websocat`

The mirror is prepared with `scripts/publish-chromium-artifacts-to-github.sh` and consumed by the browser base build through `artifact-mirror.Dockerfile`.

## Release-Mirror Candidates Still Worth Adding

If we want to reduce live external fetches further for the reproducible pair, these are the next obvious candidates:

1. `cosign-linux-amd64`
   `browser-runtime-attestor` fetches the pinned Cosign binary directly from GitHub releases with `ADD --checksum=...`.
2. Go module proxy inputs for `browser-runtime-attestor`
   The build is pinned by `go.sum`, but it still relies on live module downloads unless we add an internal module mirror or vendored modules.
3. OCI base images
   The reproducible pair already pins several base image digests, but the trust path still depends on external registries being reachable.

## How To Check A Commit

1. Run the normal image build workflow for the commit.
2. Open the `reproducible-images-<commit-sha>` artifact or workflow summary to get the immutable digest refs.
3. If you want to verify that the same source rebuilds to the same digest as the published image, run `Verify Reproducible Images` for `browser-runtime-attestor`, `browser-runtime`, or both and pass the commit SHA.

## Local Command

```bash
./scripts/ci/check-reproducible-images.sh --commit-sha "$(git rev-parse HEAD)" --service all
```
