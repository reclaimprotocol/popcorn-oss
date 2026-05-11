# Configuration

Popcorn is configured through Helm values and Kubernetes Secrets. The same charts support a local Kind demo and a production cluster, but production operators should replace all example registries, domains, credentials, and resource values.

## Deployment Profiles

### Local Kind

Use `make run-local-cluster` for the fastest self-hosted smoke test. It builds local images, creates development Secrets, installs the charts, and exposes the gateway on `http://localhost:8080`.

Local defaults are intentionally small:

- `gateway.serviceType=NodePort`
- analytics disabled unless explicitly enabled
- generated local JWT keys
- development admin credentials
- empty TURN credentials unless supplied
- one browser replica

### Existing Kubernetes Cluster

Use the example values as a starting point:

```bash
helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --create-namespace \
  --values examples/helm/platform-values.yaml

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values examples/helm/browser-fleet-values.yaml
```

Before installing into a shared cluster, replace:

- `registry`
- `imageTag`
- public domains
- service type and ingress settings
- Secret names or external secret mappings
- CPU and memory requests
- autoscaler limits

## Important Values

### Platform Chart

| Value | Default intent | Notes |
| --- | --- | --- |
| `clusterName` | identifies the deployment | Used in service metadata and analytics. |
| `provider` | `generic` for OSS examples | Keep provider-specific automation disabled unless configured. |
| `registry` | image registry prefix | OSS examples use GHCR. Internal production values may use GCP Artifact Registry. |
| `imageTag` | runtime image tag | Prefer immutable tags or digests for production. |
| `poolManager.enabled` | API allocator | Required for session creation. |
| `poolManager.jwtSecretName` | `gateway-jwt-keys` | Secret must contain `private.pem`. |
| `gateway.enabled` | public gateway | Required for browser/CDP access. |
| `gateway.jwtSecretName` | `gateway-jwt-keys` | Secret must contain `public.pem`. |
| `redis.enabled` | local Redis | Enable bundled Redis for simple installs. |
| `postgres.enabled` | local Postgres | Optional analytics storage. |
| `analytics.enabled` | analytics API | Optional for OSS local path. |
| `ttlController.enabled` | session cleanup | Recommended outside throwaway demos. |
| `otel.enabled` | observability | Optional; requires ClickHouse credentials when enabled. |
| `gkeNodePrescaler.enabled` | GKE-only scaling helper | Keep disabled for generic Kubernetes. |

### Browser Fleet Chart

| Value | Default intent | Notes |
| --- | --- | --- |
| `gatewayDomain` | gateway host | Browser runtime uses this to form callback URLs. |
| `externalSecrets.enabled` | optional secret sync | If enabled, requires External Secrets Operator and a configured secret store. |
| `ccDevicePlugin.enabled` | confidential-computing support | Keep disabled unless nodes support it. |
| `browserRuntimeImage` | browser runtime image | Use GHCR or another public/pinned image for OSS. |
| `browserRuntimeAttestor.enabled` | optional attestation sidecar | Keep disabled unless using attestation. |
| `imagePrepuller.enabled` | pre-pull runtime image | Useful for larger fleets. |
| `fleet.replicas` | desired browser capacity | Start small; use autoscaler limits for burst control. |
| `autoscaler.minReplicas` | minimum fleet size | Keep low for development. |
| `autoscaler.maxReplicas` | maximum fleet size | Set a hard cost guardrail. |

## Secrets

Use `docs/secrets.md` as the source of truth for required Secret names and keys. The charts are intentionally backend-neutral: they consume Kubernetes Secrets regardless of how those Secrets are created.

## Optional Components

Enable optional components one at a time:

- Analytics: requires analytics service and database Secrets.
- TTL controller: requires the analytics service token when analytics callbacks are enabled.
- Attestation: requires compatible nodes and digest-pinned images.
- Observability: requires exporter endpoints and ClickHouse credentials.
- Cloud-specific scaling helpers: require provider credentials and should remain disabled in generic OSS examples.

## Validation

Before applying to a cluster:

```bash
helm template popcorn-platform charts/platform \
  --values examples/helm/platform-values.yaml

helm template browser-fleet charts/browser-fleet \
  --values examples/helm/browser-fleet-values.yaml
```

After applying:

```bash
kubectl get pods
kubectl get secret gateway-jwt-keys pool-manager-env-secrets browser-turn-secret
kubectl rollout status deployment/pool-manager
kubectl rollout status deployment/popcorn-gateway
```
