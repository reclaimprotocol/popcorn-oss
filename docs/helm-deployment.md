# GCP Deployment

Popcorn OSS production deployments are supported on Google Kubernetes Engine (GKE). The local Kind path remains available for development and smoke testing, but the production documentation, chart defaults, and examples assume GCP services.

The deployment is split into two Helm charts:

- `charts/platform`: gateway, pool manager, Redis, optional control plane/Postgres/Metabase, optional TTL controller, optional GKE node prescaler, and RBAC.
- `charts/browser-fleet`: Agones browser fleet, browser runtime settings, optional attestor sidecar, optional image prepuller, and TURN secret wiring.

Install both charts into the same workload namespace unless you intentionally configure a split namespace with `poolManager.gameServerNamespace` and `gkeNodePrescaler.namespace`.

## Prerequisites

- A GCP project with a GKE cluster.
- `gcloud`, `kubectl`, and Helm 3 configured for that cluster.
- Workload Identity enabled for GKE service accounts that need GCP access.
- Agones installed in the cluster.
- External Secrets Operator installed if you want to sync secrets from GCP Secret Manager.
- A DNS name and GCP global static IP for the gateway if you want managed TLS through GKE Ingress.
- Popcorn images available to the cluster. Public OSS examples use `ghcr.io/reclaimprotocol/popcorn-oss`; production rollouts should pin digests.
- Stable JWT keys for gateway path tokens.
- `browser-turn-secret` backed by Cloudflare TURN credentials for browser access from real networks.

## Images

Use the published OSS GHCR images or mirror them into your own GCP Artifact Registry. Prefer digest refs for production:

```yaml
registry: ghcr.io/reclaimprotocol/popcorn-oss
imageTag: <commit-or-release-tag>
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
browserRuntimeAttestorImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor@sha256:<digest>
```

The browser base image assets are tracked through the `popcorn-images` submodule. Chromium artifact release assets are mirrored in `reclaimprotocol/popcorn-oss`, and both OSS and internal builds should consume that mirror.

## GCP Secrets

Popcorn reads Kubernetes Secrets. On GCP, the recommended production path is GCP Secret Manager plus External Secrets Operator using a `ClusterSecretStore` named `gcpsm`, because the bundled chart ExternalSecret templates expect that store name.

Create the required secrets in Secret Manager, then sync them into Kubernetes Secrets with the names documented in [Secrets](secrets.md):

- `gateway-jwt-keys`
- one pool-manager service-auth Secret per region, for example `pool-manager-us-central1-service-auth`
- `control-plane-secret`
- `analytics-db-secret`, if running bundled control-plane/Postgres or Metabase
- `browser-turn-secret`
- `otel-clickhouse-secret`, if observability is enabled

For a direct Kubernetes Secret bootstrap instead of External Secrets Operator, apply `examples/kubernetes/existing-secrets.example.yaml` after replacing every placeholder.

## Gateway TLS On GKE

When both values are set, the platform chart renders GKE `ManagedCertificate`, `FrontendConfig`, and GCE Ingress resources:

```yaml
gateway:
  domainName: gateway.example.com
  staticIpName: popcorn-gateway-ip
```

Create the static IP before installing the chart:

```bash
gcloud compute addresses create popcorn-gateway-ip --global
```

Point your DNS record at that IP. Managed certificate provisioning can take several minutes after DNS is correct.

## Install Agones

Install Agones once per cluster:

```bash
kubectl create namespace agones-system --dry-run=client -o yaml | kubectl apply -f -
helm repo add agones https://agones.dev/chart/stable
helm repo update
helm upgrade --install agones agones/agones \
  --namespace agones-system \
  --set agones.controller.generateTLS=false
```

For local Kind only, the Makefile constrains Agones ports to `7000-7010` so Docker can publish UDP to the host. Do not use that tiny range for production GKE capacity.

## Prepare Values

Start from the examples and copy them into a private values location outside the repo:

```bash
cp examples/helm/platform-values.yaml /tmp/popcorn-platform.gcp.yaml
cp examples/helm/browser-fleet-values.yaml /tmp/popcorn-browser-fleet.gcp.yaml
```

At minimum, update:

```yaml
# platform values
clusterName: popcorn-prod
provider: gcp
region: us-central1
registry: ghcr.io/reclaimprotocol/popcorn-oss
imageTag: <commit-or-release-tag>

poolManager:
  enabled: true
  controlPlaneUrl: http://control-plane.popcorn.svc.cluster.local:3000

controlPlane:
  enabled: true
  regions:
    - name: us-central1
      clusterName: popcorn-prod
      poolManagerUrl: http://pool-manager.popcorn.svc.cluster.local
      publicGatewayUrl: https://gateway.example.com
      enabled: true

gateway:
  enabled: true
  domainName: gateway.example.com
  staticIpName: popcorn-gateway-ip

redis:
  enabled: true

ttlController:
  enabled: true

gkeNodePrescaler:
  enabled: false
  project: example-project
  cluster: popcorn-prod
  location: us-central1
  nodePool: browser-pool
```

```yaml
# browser fleet values
region: us-central1
gatewayDomain: gateway.example.com

externalSecrets:
  enabled: true

serviceAccount:
  gcpServiceAccount: browser-runtime@example-project.iam.gserviceaccount.com

browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>

browserRuntimeAttestor:
  enabled: false

ccDevicePlugin:
  enabled: false

fleet:
  replicas: 2

autoscaler:
  minReplicas: 2
  maxReplicas: 20
```

Enable `browserRuntimeAttestor` and `ccDevicePlugin` only when deploying on compatible confidential-computing GKE nodes with the required IAM and digest-pinned images.

## Install Popcorn

```bash
kubectl create namespace popcorn --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --values /tmp/popcorn-platform.gcp.yaml

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values /tmp/popcorn-browser-fleet.gcp.yaml
```

Watch rollout state:

```bash
kubectl -n popcorn get pods
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
kubectl -n popcorn rollout status deployment/pool-manager
kubectl -n popcorn rollout status deployment/popcorn-gateway
```

## Verify A Session

After the gateway DNS and certificate are ready, create a session through the
control plane:

```bash
curl -sS -X POST https://control-plane.example.com/v1/sessions \
  -H "Authorization: Bearer $CLIENT_ID:$CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"gcp-smoke","regions":["us-central1"]}'
```

For new public clients, configure the control plane and create client records,
then call `POST /v1/sessions` on the control plane. The pool manager exposes
only internal session allocation endpoints authenticated with that region's
service-auth Secret.

## Upgrade

Before upgrading, confirm the target image digests and submodule lock in [Images and releases](images-and-releases.md). Then upgrade the two charts with the same values files and new image refs:

```bash
helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --values /tmp/popcorn-platform.gcp.yaml

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values /tmp/popcorn-browser-fleet.gcp.yaml
```

Keep JWT signing keys stable across rollouts. Rotating `gateway-jwt-keys` invalidates outstanding browser, CDP, runtime API, and proof URLs.

## Uninstall

```bash
helm uninstall browser-fleet --namespace popcorn
helm uninstall popcorn-platform --namespace popcorn
```

Agones and External Secrets Operator are cluster-level dependencies. Remove them only if no other workloads use them:

```bash
helm uninstall agones --namespace agones-system
```

## Production Notes

- Expose only the gateway publicly.
- Keep Redis, pool manager, control plane, Postgres, and Metabase internal unless you intentionally expose them.
- Use GKE Ingress with a managed certificate or another GCP-managed TLS path.
- Store production secrets in GCP Secret Manager or pre-created Kubernetes Secrets, never in Helm values.
- Configure Cloudflare TURN for browser access from real networks.
- Keep `webrtc.advertiseHost` empty in GKE; it is for same-machine Kind only.
- Set `autoscaler.maxReplicas` and GKE node pool limits as cost guardrails.
- Use `gkeNodePrescaler` only after its GCP IAM and node pool settings are configured.
- Enable attestation only on compatible confidential-computing GKE nodes.
