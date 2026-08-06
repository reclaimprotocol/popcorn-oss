# Production installation on GKE

This runbook installs one Popcorn region into a GKE Standard cluster. It assumes
the decisions in [Requirements and planning](prerequisites.md) are complete.

## Installation model

Install three layers in this order:

1. Cluster infrastructure: Agones and, optionally, External Secrets Operator.
2. `popcorn-platform`: pool manager, gateway, control plane, route-state Redis,
   TTL controller, and optional observability components.
3. `browser-fleet`: Agones Fleet, FleetAutoscaler, browser runtime, and optional
   browser-side components.

Agones is cluster-scoped infrastructure. Install it once. The two Popcorn Helm
releases should normally share one namespace.

## 1. Set installation variables

```bash
export POPCORN_NAMESPACE=popcorn
export POPCORN_CLUSTER=popcorn-prod
export POPCORN_REGION=us-central1
export POPCORN_GATEWAY_DOMAIN=browser.example.com
```

Confirm the target cluster before doing anything else:

```bash
kubectl config current-context
kubectl get nodes -L kubernetes.io/arch,topology.kubernetes.io/zone
```

## 2. Install Agones

The repository vendors the tested Agones chart:

```bash
helm upgrade --install agones charts/browser-fleet/charts/agones-1.57.0.tgz \
  --namespace agones-system \
  --create-namespace \
  --set agones.controller.generateTLS=false \
  --set-json "gameservers.namespaces=[\"$POPCORN_NAMESPACE\"]"

kubectl -n agones-system rollout status deployment/agones-controller
kubectl -n agones-system rollout status deployment/agones-extensions
```

Popcorn ports use Agones `portPolicy: None`; do not configure an Agones host
port range for Popcorn.

## 3. Prepare production values

Copy the examples into a private deployment repository or another location
outside this checkout:

```bash
cp examples/helm/platform-values.yaml /tmp/popcorn-platform.yaml
cp examples/helm/browser-fleet-values.yaml /tmp/popcorn-browser.yaml
```

At minimum, change:

- `clusterName`, `region`, `registry`, and `imageTag` in platform values;
- `gateway.domainName`, `gateway.staticIpName`, and desired replica counts;
- `controlPlane.regions` and its pool-manager service-token Secret reference;
- Postgres, admin, gateway JWT, and service-token Secret names;
- the route-state choice: bundled HA Redis or an external managed Redis;
- `region`, `gatewayDomain`, `browserRuntimeImage`, Fleet resources, and
  autoscaler bounds in browser values.

Leave `agones.install=false`. Pin production images instead of using `latest`.
See [Configuration](configuration.md) for design choices and
[Helm values](chart-options.md) for the complete reference.

## 4. Create Secrets

Create the namespace and required Secrets before installing workloads:

```bash
kubectl create namespace "$POPCORN_NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Follow [Secrets](secrets.md). A standard deployment needs:

- `gateway-jwt-keys`;
- `pool-manager-service-auth`;
- `control-plane-secret`;
- `analytics-db-secret`.

Do not generate production values with the local Makefile targets. They create
development credentials.

## 5. Render and review

Rendering is a required preflight, not just a debugging step:

```bash
helm lint charts/platform
helm lint charts/browser-fleet

helm template popcorn-platform charts/platform \
  --namespace "$POPCORN_NAMESPACE" \
  --values /tmp/popcorn-platform.yaml > /tmp/popcorn-platform-rendered.yaml

helm template browser-fleet charts/browser-fleet \
  --namespace "$POPCORN_NAMESPACE" \
  --values /tmp/popcorn-browser.yaml > /tmp/popcorn-browser-rendered.yaml
```

Review image references, public Services and Ingresses, Secret names, RBAC,
node selectors, tolerations, resource limits, and optional components.

## 6. Install the platform

```bash
helm upgrade --install popcorn-platform charts/platform \
  --namespace "$POPCORN_NAMESPACE" \
  --values /tmp/popcorn-platform.yaml \
  --wait --timeout 10m
```

The control-plane migration Job must finish successfully before the control
plane is considered ready:

```bash
kubectl -n "$POPCORN_NAMESPACE" get jobs,pods
kubectl -n "$POPCORN_NAMESPACE" rollout status deployment/pool-manager
kubectl -n "$POPCORN_NAMESPACE" rollout status deployment/popcorn-gateway
kubectl -n "$POPCORN_NAMESPACE" rollout status deployment/control-plane
```

If a component is disabled in your values, omit its rollout check.

## 7. Install the browser fleet

```bash
helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace "$POPCORN_NAMESPACE" \
  --values /tmp/popcorn-browser.yaml \
  --wait --timeout 15m
```

Verify Agones capacity:

```bash
kubectl -n "$POPCORN_NAMESPACE" get fleet,fleetautoscaler,gameservers
kubectl -n "$POPCORN_NAMESPACE" get pods -l app=browser-runtime -o wide
```

At least one GameServer must be `Ready` before allocation can succeed.

## 8. Complete DNS and TLS

When `gateway.staticIpName` is set, the platform chart creates a GCE Ingress.
When `gateway.domainName` is also set, it creates a GKE ManagedCertificate and
HTTPS redirect. It also enables a Network Endpoint Group on the gateway
Service; no separate NEG annotation is required. Point DNS at the reserved
global IP and wait for both the Ingress and certificate to become active.

```bash
kubectl -n "$POPCORN_NAMESPACE" get ingress,managedcertificate
kubectl -n "$POPCORN_NAMESPACE" describe managedcertificate popcorn-gateway
```

Do not run production sessions over plaintext HTTP. See
[Networking](networking.md) for private exposure and non-default topologies.

## 9. Run the acceptance test

If the control plane is private, port-forward it for the operator test:

```bash
kubectl -n "$POPCORN_NAMESPACE" port-forward svc/control-plane 8081:3000
```

Create a narrowly scoped client:

```bash
export CONTROL_PLANE_URL=http://localhost:8081
export CONTROL_PLANE_ADMIN_TOKEN='<admin token>'

CLIENT_JSON=$(curl -fsS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"install check\",\"allowedClusters\":[\"$POPCORN_CLUSTER\"]}")

CLIENT_ID=$(printf '%s' "$CLIENT_JSON" | jq -r .clientId)
CLIENT_SECRET=$(printf '%s' "$CLIENT_JSON" | jq -r .clientSecret)

SESSION_JSON=$(curl -fsS -X POST "$CONTROL_PLANE_URL/v1/sessions" \
  -H "Authorization: Bearer $CLIENT_ID:$CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"install-check\",\"regions\":[\"$POPCORN_REGION\"]}")

printf '%s\n' "$SESSION_JSON" | jq
```

Acceptance requires all of the following:

- the returned `url` loads LiveView over HTTPS;
- `cdpUrl` accepts a client automation connection;
- the session appears in control-plane admin state;
- deleting the session removes its GameServer and route state;
- no required workload is restarting or unschedulable.

## 10. Production gate

Before opening access:

- [ ] Postgres backup and restore are tested.
- [ ] Redis topology matches the required recovery objective.
- [ ] Gateway and browser capacity span the intended failure domains.
- [ ] Session cleanup is enabled.
- [ ] Public endpoints use TLS and internal endpoints remain private.
- [ ] Session URLs are redacted from logs.
- [ ] Images are pinned and pullable on a newly created node.
- [ ] Alerts cover failed allocations, no Ready GameServers, gateway errors,
      and database/Redis health.

Continue with [Operations](operations.md), [High availability](high-availability.md),
and [Upgrades](upgrades.md).
