# Images And Releases

Popcorn OSS v1 keeps image ownership explicit:

- Popcorn platform services live in this repository.
- Browser base image assets live in the separate [popcorn-images](../popcorn-images/README.md) repository.
- The AI-agent component is excluded from the OSS v1 release export.

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
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-images/browser-runtime:latest
browserRuntimeAttestorImage: ghcr.io/reclaimprotocol/popcorn-images/browser-runtime-attestor:latest
```

The OSS CI workflow publishes platform service images from `reclaimprotocol/popcorn-oss` to GHCR on pushes to `main`, release tags, and manual runs. Pull requests only smoke-build images and do not push packages.

Internal production deployments can continue to use GCP Artifact Registry values in the internal chart defaults. Do not copy private production registry references into the OSS export.

## Browser Images

`popcorn-images` remains a separate OSS project. Clone Popcorn with submodules:

```bash
git clone --recursive https://github.com/reclaimprotocol/popcorn-oss.git
```

The `reclaimprotocol/popcorn-oss` repository may remain private while release validation is in progress.

Or initialize later:

```bash
git submodule update --init --recursive
```

The browser runtime build uses image assets from:

```text
popcorn-images/
```

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
ghcr.io/reclaimprotocol/popcorn-images/browser-runtime@sha256:<digest>
ghcr.io/reclaimprotocol/popcorn-images/browser-runtime-attestor@sha256:<digest>
```

Avoid mutable tags for production rollouts unless the tag is only used to discover a digest and the chart ultimately deploys the digest.

## OSS Export

The public OSS export flow is expected to be owned by a parallel PR:

```bash
scripts/oss/export.sh
```

That script is expected to prepare a public-safe tree by excluding private deployment material and generated secrets. This docs PR does not implement the export script.

## Release Checklist

- Root `LICENSE` exists.
- Public README and docs do not mention private registries, domains, or credentials.
- The AI-agent component is not part of the OSS v1 export path.
- `popcorn-images` submodule points to the intended public release.
- Local Kind demo works from a fresh clone with submodules.
- OSS Helm example values are present.
- Images are built for supported platforms.
- Production image references are digest-pinned.
- Attestor images are signed if attestation is documented for the release.
- Screenshots or GIF placeholders are present if used in release notes.

## Versioning

Use a single release version across the platform image set when possible:

```text
v0.1.0
```

For production chart values, record both the human version and digest:

```yaml
imageTag: v0.1.0
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-images/browser-runtime@sha256:<digest>
```

## License Blocker

If the repository has no root `LICENSE` file, OSS launch is blocked. Add the project license before publishing a release or inviting external contributions.
