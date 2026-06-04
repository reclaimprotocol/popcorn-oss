# Images And Releases

Popcorn OSS v1 keeps image ownership explicit:

- Popcorn platform services live in this repository.
- Browser base image assets live in the separate [popcorn-images](../popcorn-images/README.md) repository.

## Image Set

The OSS v1 platform expects these runtime images:

- `pool-manager`
- `gateway`
- `browser-node` or `browser-runtime`
- `ttl-controller`
- optional `browser-runtime-attestor`

Optional analytics and observability images may be used by operators, but the core local demo should not require hosted analytics.

Public OSS examples use GitHub Container Registry style references:

```yaml
registry: ghcr.io/reclaimprotocol/popcorn-oss
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime:<commit-sha>
browserRuntimeAttestorImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor:<commit-sha>
```

The OSS CI workflow publishes platform service images from `reclaimprotocol/popcorn-oss` to GHCR on pushes to `main`, release tags, and manual runs. Pull requests only smoke-build images and do not push packages.

The reproducible browser image workflow publishes:

```text
ghcr.io/reclaimprotocol/popcorn-oss/browser-base:<popcorn-images-submodule-sha>
ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime:<commit-sha>
ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor:<commit-sha>
```

Those digest refs are signed with keyless cosign by `.github/workflows/reproducible-images.yml`.

Production deployments can either pull the published GHCR images directly or mirror them into their own GCP Artifact Registry. Public examples use GHCR.

If GHCR packages are still private during a test, create a Kubernetes
`docker-registry` Secret and reference it with `imagePullSecrets` in both
charts. The live IP-only GKE test required this until package visibility is
made public.

Browser runtime images are published by commit tag or digest. Do not assume
`browser-runtime:latest` exists; use a known commit tag or an immutable digest
in `browserRuntimeImage`.

## Browser Images

`popcorn-images` remains a separate OSS project and the source tree for browser image builds. Chromium artifact release assets are mirrored through `reclaimprotocol/popcorn-oss`. Clone Popcorn with submodules:

```bash
git clone --recursive https://github.com/reclaimprotocol/popcorn-oss.git
```

Or initialize later:

```bash
git submodule update --init --recursive
```

The browser runtime build uses image assets from:

```text
popcorn-images/
```

The OSS reproducible workflow sets `GITHUB_ARTIFACT_MIRROR_REPO=reclaimprotocol/popcorn-oss` so Chromium release assets are resolved from the OSS repository before falling back to pinned upstream URLs.

## Local Images

For Kind:

```bash
make run-local-cluster
```

The local flow builds images such as:

```text
popcorn/pool-manager:local
popcorn/gateway:local
popcorn/browser-node:local
```

Use explicit service build targets when you only want the OSS v1 local image set:

```bash
make build-pool-manager
make build-gateway
make build-browser-node
make build-ttl-controller
```

Then it loads them into the Kind cluster.

## Release Images

Production deployments should use immutable image references:

```text
ghcr.io/reclaimprotocol/popcorn-oss/browser-base@sha256:<digest>
ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor@sha256:<digest>
```

Avoid mutable tags for production rollouts unless the tag is only used to discover a digest and the chart ultimately deploys the digest.

Verify the keyless signature before rollout:

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/reclaimprotocol/popcorn-oss/.github/workflows/reproducible-images.yml@refs/(heads/main|tags/v.*)' \
  ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
```

## Release Checklist

- Root `LICENSE` exists and matches the intended release license.
- Public README and docs do not mention private registries, domains, or credentials.
- Private components are not part of the OSS release branch.
- `popcorn-images` submodule points to the intended public release.
- Local Kind demo works from a fresh clone with submodules.
- OSS Helm example values are present.
- Images are built for supported platforms.
- Production image references are digest-pinned.
- Attestor images are signed if attestation is documented for the release.

## Versioning

Use a single release version across the platform image set when possible:

```text
v0.1.0
```

For production chart values, record both the human version and digest:

```yaml
imageTag: v0.1.0
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
browserRuntimeAttestorImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor@sha256:<digest>
```
