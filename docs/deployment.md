# Deployment

The supported production path for Popcorn OSS is Google Kubernetes Engine
(GKE). Local Kind is for development and smoke testing.

## GKE Cluster Settings

Use a GKE Standard cluster for production. Popcorn runs browser workloads as
Agones GameServers, so the cluster should be built for long-running browser
pods, dynamic capacity, and public gateway ingress.

Recommended baseline:

- VPC-native networking.
- Workload Identity enabled, especially if using External Secrets Operator,
  GCP Secret Manager, the GKE node prescaler, or attestation.
- Shielded nodes enabled.
- A managed node pool with autoscaling enabled.
- Browser-capable node size, for example an `n2d-standard-8` class machine or
  larger once load increases.
- Enough node disk for browser images; internal deployments use 200 GB
  balanced persistent disks as a starting point.
- Node service account permissions for image pulls, logging, and monitoring.
- A GCP global static IP for the gateway Ingress.
- Optional: a separate GCP global static IP and DNS name for the control plane
  if you expose the client/admin API publicly.
- DNS pointed at those IPs before relying on managed certificates.

If you want attestation, create the browser node pool with Confidential GKE
Nodes enabled and use a machine family that supports GCP confidential computing,
such as AMD-based `n2d` machines in supported regions. Then enable the browser
attestor and confidential-computing device plugin in the browser-fleet values.
See [Attestation](attestation.md#setup) for the concrete node-pool, IAM, and
Helm values.

If you do not need attestation, confidential nodes are optional. Keep
`browserRuntimeAttestor.enabled=false` and `ccDevicePlugin.enabled=false`.

For WebRTC, plan for both TURN and direct UDP:

- Production browser access should have TURN credentials in
  `browser-turn-secret`.
- Direct GameServer UDP needs firewall rules and an Agones port range that fits
  your network policy.
- The local Kind UDP range is intentionally tiny and should not be copied into
  production.

See [Browser networking](networking.md) for Cloudflare TURN setup, static ICE
server options, and direct Agones UDP guidance.

## Production Shape

Install two Helm releases into the same namespace:

- `charts/platform`: gateway, pool manager, Redis, control plane, transitional
  bundled Postgres, TTL controller, RBAC, and optional operations services.
- `charts/browser-fleet`: Agones Fleet, browser runtime, WebRTC/TURN settings,
  autoscaler, and optional attestor.

Use one namespace unless you have a specific reason to split platform and
browser workloads.

## Requirements

- GKE Standard cluster with the settings above.
- Agones installed in the cluster, or `agones.install=true` in the
  browser-fleet values for a fresh cluster.
- `gcloud`, `kubectl`, Helm 3, jq, and openssl.
- DNS name and GCP global static IP for the gateway.
- Optional control-plane DNS name and GCP global static IP, or a private access
  plan such as port-forward, VPN, or internal ingress.
- Popcorn images available to the cluster.
- Kubernetes Secrets from [Secrets](secrets.md).
- TURN credentials for browser access from real networks.

The control plane and Metabase expect `analytics-db-secret` to point at an
existing Postgres database. Use managed Postgres or a database you operate
outside the platform chart.

External Secrets Operator is optional, but recommended when syncing from GCP
Secret Manager.

## Install Agones

For a fresh self-hosted cluster, the browser-fleet chart can install Agones as
an optional dependency:

```yaml
# browser-fleet values
agones:
  install: true

agonesInstaller:
  gameservers:
    namespaces:
      - popcorn
    minPort: 59000
    maxPort: 61000
```

If Agones is already installed in the cluster, keep `agones.install=false`.
Agones is cluster-level infrastructure, so avoid letting multiple Helm releases
manage it.

## Prepare Values

Start from examples and edit copies outside the repo:

```bash
cp examples/helm/platform-values.yaml /tmp/popcorn-platform.yaml
cp examples/helm/browser-fleet-values.yaml /tmp/popcorn-browser-fleet.yaml
```

Minimum platform shape:

```yaml
clusterName: popcorn-prod
provider: gcp
region: us-central1
registry: ghcr.io/reclaimprotocol/popcorn-oss
imageTag: <release-or-commit-tag>

poolManager:
  enabled: true

gateway:
  enabled: true
  replicas: 2
  domainName: gateway.example.com
  staticIpName: popcorn-gateway-ip

controlPlane:
  enabled: true
  # Leave these empty if the control plane stays private and operators use
  # port-forward, VPN, or an internal ingress instead.
  domainName: control-plane.example.com
  staticIpName: popcorn-control-plane-ip
  regions:
    - name: us-central1
      clusterName: popcorn-prod
      poolManagerUrl: http://pool-manager.popcorn.svc.cluster.local
      publicGatewayUrl: https://gateway.example.com
      enabled: true

redis:
  enabled: true

postgres:
  enabled: true

ttlController:
  enabled: true
```

Minimum browser fleet shape:

```yaml
region: us-central1
gatewayDomain: gateway.example.com
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>

agones:
  install: true

agonesInstaller:
  gameservers:
    namespaces:
      - popcorn
    minPort: 59000
    maxPort: 61000

fleet:
  replicas: 2

autoscaler:
  minReplicas: 2
  maxReplicas: 20
```

Leave `webrtc.advertiseHost` empty in GKE. It is for same-machine Kind only.

## Install

```bash
kubectl create namespace popcorn --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --values /tmp/popcorn-platform.yaml

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values /tmp/popcorn-browser-fleet.yaml
```

Watch rollout:

```bash
kubectl -n popcorn get pods
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
kubectl -n popcorn rollout status deployment/pool-manager
kubectl -n popcorn rollout status deployment/popcorn-gateway
```

## Verify

First create client credentials. Use the public control-plane URL if you exposed
it, or port-forward the service for an operator-only smoke test:

```bash
kubectl -n popcorn port-forward svc/control-plane 8081:3000
```

In another shell:

```bash
CONTROL_PLANE_URL=http://localhost:8081
CONTROL_PLANE_ADMIN_TOKEN=<admin-token-from-control-plane-secret>

CLIENT_JSON=$(curl -sS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"gke smoke"}')

export CLIENT_ID=$(printf '%s' "$CLIENT_JSON" | jq -r .clientId)
export CLIENT_SECRET=$(printf '%s' "$CLIENT_JSON" | jq -r .clientSecret)
```

Then create a session:

```bash
curl -sS -X POST "$CONTROL_PLANE_URL/v1/sessions" \
  -H "Authorization: Bearer $CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"gke-smoke","regions":["us-central1"]}'
```

The response should include `url`, `cdpUrl`, `apiUrl`, `sessionId`, and
`region`.

## Upgrade

Upgrade both charts with the same private values files and new image refs:

```bash
helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --values /tmp/popcorn-platform.yaml

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values /tmp/popcorn-browser-fleet.yaml
```

Keep JWT signing keys stable across rollouts. Rotating them invalidates active
browser URLs.
