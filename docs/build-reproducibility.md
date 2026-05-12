# Build Reproducibility

The OSS reproducible image path covers:

- `browser-base`
- `browser-runtime`
- `browser-runtime-attestor`

These images are published to:

```text
ghcr.io/reclaimprotocol/popcorn-oss/browser-base
ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime
ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor
```

The public `reclaimprotocol/popcorn-images` repository remains the source of the `popcorn-images` submodule. Chromium artifact release assets are mirrored in `reclaimprotocol/popcorn-oss`, which is the shared artifact mirror for both OSS and internal builds.

## What The Workflow Publishes

`.github/workflows/reproducible-images.yml` builds the three images for `linux/amd64`, pushes immutable tags to GHCR, signs each pushed digest with keyless cosign, and uploads a `reproducible-images-<commit-sha>` artifact.

Tag policy:

- `browser-runtime:<commit-sha>`
- `browser-runtime-attestor:<commit-sha>`
- `browser-base:<popcorn-images-submodule-sha>`

The uploaded manifest records:

- Popcorn source commit
- `SOURCE_DATE_EPOCH`
- resolved GHCR digest refs
- `popcorn-images` submodule SHA
- Chromium artifact mirror lock tag
- keyless cosign issuer and workflow identity

## Locked Inputs

`browser-base` is built from the pinned `popcorn-images` submodule at:

```text
popcorn-images/
```

The Chromium artifact lock lives in:

```text
popcorn-images/images/chromium-headful/chromium-lock.json
```

The lock file determines the artifact mirror release tag through:

```bash
./scripts/chromium-lock-env.sh linux/amd64
```

The OSS workflow sets `GITHUB_ARTIFACT_MIRROR_REPO=reclaimprotocol/popcorn-oss`, so artifact downloads prefer public GitHub release assets from the OSS repository before falling back to the upstream URLs recorded in the lock.

## Verify A Published Digest

Get the digest from the workflow summary or the uploaded `reproducible-images-<commit-sha>` artifact, then verify the keyless signature:

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/reclaimprotocol/popcorn-oss/.github/workflows/reproducible-images.yml@refs/(heads/main|tags/v.*)' \
  ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
```

Use the same command for `browser-base` and `browser-runtime-attestor` by replacing the image name and digest.

## Verify Source, Submodule, And Artifact Lock

1. Check out the recorded source commit:

   ```bash
   git checkout <commit-sha>
   git submodule update --init --recursive
   ```

2. Confirm the submodule SHA matches the manifest:

   ```bash
   git submodule status popcorn-images
   ```

3. Confirm the artifact lock tag matches the manifest:

   ```bash
   ./scripts/chromium-lock-env.sh linux/amd64
   ```

4. Compare a local rebuild with the published GHCR image config digests:

   ```bash
   ./scripts/ci/check-reproducible-images.sh --commit-sha "$(git rev-parse HEAD)" --service all
   ```

The verifier pulls from `ghcr.io/reclaimprotocol/popcorn-oss/*`, rebuilds from the current checkout, and writes `dist/reproducible-images-check.json` plus a Markdown summary. If a digest differs, it also writes per-image layer diff reports under `dist/`.

## Current Boundaries

The reproducibility claim applies only to the three browser images listed above. Platform service images remain normal OSS CI images unless they receive the same pinned-input treatment.
