# Images and releases

Treat a Popcorn release as a reviewed set of chart versions, service images,
browser image, configuration schema, and database migration—not as one mutable
tag.

## Image inventory

| Image | Chart | Role |
| --- | --- | --- |
| `pool-manager` | platform | regional allocation and route publication |
| `gateway` | platform | authenticated browser/CDP proxy |
| `control-plane` | platform | client/admin API and migrations |
| `ttl-controller` | platform | expired GameServer cleanup |
| `browser-runtime` | browser-fleet | Chromium, LiveView, and CDP proxies |
| `browser-runtime-attestor` | browser-fleet, optional | confidential proof service |

The HA Redis and OTEL agent use third-party images configured by chart values.
Session extensions bring their own operator-owned images.

## Production pinning

Platform services share `registry` and `imageTag`; the browser and attestor have
full image values:

```yaml
registry: ghcr.io/reclaimprotocol/popcorn-oss
imageTag: <immutable release or commit tag>
```

```yaml
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
browserRuntimeAttestorImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor@sha256:<digest>
```

Prefer immutable digests. If platform charts only accept a shared tag, publish
that tag immutably in the controlled registry and record each resolved digest
in the deployment change.

## Browser build

The maintained browser source is `images/minimal-vnc-desktop`. It combines the
desktop, noVNC/LiveView proxy, Chromium distribution, CDP proxies, runtime
entrypoint, and pinned build inputs.

Relevant inputs include:

```text
images/minimal-vnc-desktop/Dockerfile
images/minimal-vnc-desktop/locks/
images/minimal-vnc-desktop/prepare-artifacts.sh
images/minimal-vnc-desktop/proxy/
```

The image is Linux/amd64. Third-party notices and packaged licenses are
described in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Local builds

The Kind workflow builds and loads local images:

```bash
make build-pool-manager
make build-control-plane
make build-gateway
make build-local-browser-runtime
make build-ttl-controller
```

`make run-local-cluster` invokes the required build and load steps
automatically.

## Release verification

The reproducible image workflow publishes commit-addressed browser runtime and
attestor artifacts plus a manifest describing source commit and pinned inputs.
When a release supplies keyless Cosign signatures, verify the immutable digest
against the expected workflow identity:

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp \
  'https://github.com/reclaimprotocol/popcorn-oss/.github/workflows/reproducible-images.yml@refs/(heads/main|tags/v.*)' \
  ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
```

Verification must cover the exact digest deployed, not a mutable alias.

## Rebuild check

At the source commit recorded by the release manifest:

```bash
./scripts/ci/check-reproducible-images.sh \
  --commit-sha "$(git rev-parse HEAD)" \
  --service all
```

The check rebuilds the reproducible browser images and compares configuration
digests, writing reports under `dist/`. Platform service images follow the
normal OSS build workflow unless explicitly included in the reproducible set.

## Rollout strategy

1. Verify chart schemas and release notes.
2. Resolve and record every image digest.
3. Scan and signature-check images.
4. Render production values.
5. Back up Postgres.
6. Upgrade the platform and migration Job.
7. Test a canary session.
8. Upgrade a small browser Fleet or staging region.
9. Test LiveView, restricted CDP, extensions, TTL, and deletion.
10. Expand capacity and retain rollback artifacts.

Browser image rollout can terminate active GameServers. Plan it as workload
maintenance even when the Kubernetes rollout itself is healthy.

## Private registry mirrors

Mirror all required images, including dependencies and extension images, before
an isolated deployment. Configure `imagePullSecrets` in both charts and test a
newly provisioned node with an empty image cache.

## Release record

Keep this information for every production change:

- source commit and release tag;
- platform and browser chart versions;
- every deployed image digest;
- values repository commit;
- database backup/restore point and migration result;
- signature/scan results;
- acceptance-test result;
- known rollback revision and schema compatibility.

Use [Upgrades](upgrades.md) for the operational procedure.
