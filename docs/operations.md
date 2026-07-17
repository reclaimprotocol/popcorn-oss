# Operations

This page is a short runbook for self-hosted Popcorn releases. Start with the
smallest working deployment, validate it, then add scale and optional services
one change at a time.

## Preflight Validation

Render the charts before every install or upgrade:

```bash
helm template popcorn-platform charts/platform \
  --namespace popcorn \
  --values examples/helm/platform-values.yaml

helm template browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values examples/helm/browser-fleet-values.yaml
```

Check that required Secrets exist and contain the expected keys:

```bash
kubectl -n popcorn get secret gateway-jwt-keys pool-manager-service-auth control-plane-secret analytics-db-secret browser-turn-secret
```

For production, confirm these choices before applying:

- images are digest-pinned or come from a controlled registry mirror;
- gateway and control-plane domains have TLS ready;
- Redis, Postgres, pool manager, and internal control-plane routes are private;
- TURN credentials are present for browser traffic outside a same-machine test;
- `controlPlane.regions` points at the correct pool-manager URL and token Secret.

## Install Order

Install the platform first, then the browser fleet:

```bash
helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --values <your-platform-values.yaml>

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values <your-browser-fleet-values.yaml>
```

Validate the core path:

```bash
kubectl -n popcorn rollout status deployment/pool-manager
kubectl -n popcorn rollout status deployment/popcorn-gateway
kubectl -n popcorn rollout status deployment/control-plane
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
```

Create a test client in the control plane, then call `POST /v1/sessions`. See
[Deployment](deployment.md#verify) for copy-paste commands. A healthy response
returns browser, CDP, and runtime API URLs.

## Upgrades

Use one release change per maintenance window when possible:

1. Read release notes and image tags.
2. Render both charts with your private values.
3. Back up Postgres before control-plane or schema changes.
4. Upgrade `charts/platform`.
5. Wait for platform rollouts.
6. Upgrade `charts/browser-fleet`.
7. Start a new browser session and test browser view plus CDP.

Avoid rotating JWT keys during normal upgrades. JWT key rotation invalidates
active browser URLs.

## Scaling

Browser capacity is controlled by the browser fleet chart:

- `fleet.replicas` sets warm capacity.
- `autoscaler.minReplicas` keeps spare servers ready.
- `autoscaler.maxReplicas` caps burst capacity.
- browser runtime CPU and memory requests determine node packing.

After changing capacity, watch Agones and pods:

```bash
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
kubectl -n popcorn get pods -o wide
```

If sessions queue or fail allocation, raise warm replicas, raise the autoscaler
ceiling, or add browser nodes. If nodes are full, increasing Fleet size alone
will not help.

## Optional Components

Enable optional components after the base session lifecycle is healthy.

### TTL Controller

Keeps old sessions and GameServers from lingering. Verify it can reach the
control plane and has `CONTROL_PLANE_SERVICE_AUTH_TOKEN`.

### OpenTelemetry

Use the bundled collector when you need browser GameServer log export. Enabling
`otel.enabled=true` requires exactly one external OTLP collector endpoint.
Pool-manager ClickHouse writes are an optional legacy fallback behind
`otel.clickhouse.enabled=true`. See [Observability](observability.md).

### GKE Node Prescaler

Use only on GKE. Confirm Workload Identity and dry-run behavior before allowing
it to write node-pool sizes.

### Attestation

Enable confidential-computing attestation only after the browser fleet works on
the target node pool. Check device plugin readiness before enforcing policy.

## Day-2 Checks

Run these checks after deploys and during regular operations:

```bash
kubectl -n popcorn get pods
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
kubectl -n popcorn logs deployment/pool-manager --tail=100
kubectl -n popcorn logs deployment/popcorn-gateway --tail=100
kubectl -n popcorn logs deployment/control-plane --tail=100
```

Also verify:

- new sessions can be created through `/v1/sessions`;
- browser view, CDP, and runtime API URLs all work with their own tokens;
- TURN relay is used when direct WebRTC cannot connect;
- database storage and backups are healthy;
- Secret expiry dates and rotation windows are tracked;
- image pull credentials still work;
- autoscaler limits match expected peak load;
- fleet allocation and session stats look sane in the control-plane admin
  **Analytics** tab.

## Advanced Notes

For multi-region installs, keep one pool-manager service token per region and
reference each token from `controlPlane.regions[].poolManagerAuth.secretName`.

For local Kind, `make run-local-cluster` publishes the gateway on
`http://localhost:8080` and maps a small Agones UDP range for same-machine
WebRTC testing. Do not treat that path as a production networking model.
