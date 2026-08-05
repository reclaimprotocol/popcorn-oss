# Troubleshooting

Start with evidence and isolate the failing hop. Do not change several values
at once, delete state blindly, or share signed URLs and Secret contents.

## First five minutes

```bash
export POPCORN_NAMESPACE=popcorn

helm -n "$POPCORN_NAMESPACE" list
kubectl -n "$POPCORN_NAMESPACE" get deploy,ds,job,pods -o wide
kubectl -n "$POPCORN_NAMESPACE" get fleet,fleetautoscaler,gameservers
kubectl -n "$POPCORN_NAMESPACE" get svc,ingress,endpoints
kubectl -n "$POPCORN_NAMESPACE" get events --sort-by=.lastTimestamp | tail -50
```

Then identify the stage:

```text
render/install -> pod startup -> Ready GameServer -> allocation
-> control-plane response -> gateway authorization -> browser upstream
```

## Helm render or upgrade fails

Render locally with the exact values layers:

```bash
helm lint charts/platform
helm lint charts/browser-fleet
helm template test charts/platform -n "$POPCORN_NAMESPACE" -f <platform-values>
helm template test charts/browser-fleet -n "$POPCORN_NAMESPACE" -f <browser-values>
```

Common causes:

- an invalid `sessionExtensions` object;
- both or neither OTLP endpoint while `otel.enabled=true`;
- incomplete control-plane region or additional-ingress objects;
- an extension `routing` block missing `portName`, `port`, or `routeKey`;
- values intended for one chart passed only to the other.

If the platform upgrade waits on `control-plane-migrate`, inspect the Job:

```bash
kubectl -n "$POPCORN_NAMESPACE" get job control-plane-migrate
kubectl -n "$POPCORN_NAMESPACE" logs job/control-plane-migrate
```

Check Postgres Secret keys, DNS, TLS/CA settings, credentials, and migration
permissions. Do not bypass the Job.

## Pods are Pending

```bash
kubectl -n "$POPCORN_NAMESPACE" describe pod <pod>
kubectl get nodes -L kubernetes.io/arch,topology.kubernetes.io/zone
```

Look for:

- insufficient CPU, memory, or ephemeral storage;
- amd64 browser image scheduled to an incompatible node;
- node selector/toleration mismatch;
- unavailable runtime class;
- confidential-computing resource request on ordinary nodes;
- unbound Redis PVCs;
- PDB or topology constraints stricter than available nodes.

## ImagePullBackOff

```bash
kubectl -n "$POPCORN_NAMESPACE" describe pod <pod>
kubectl -n "$POPCORN_NAMESPACE" get secret
```

Verify the exact image exists for the node architecture, the digest/tag is
correct, registry credentials are attached through `imagePullSecrets`, and the
node can reach the registry. Test on a newly created browser node, not only a
node with cached layers.

## CreateContainerConfigError

This normally means a missing Secret, key, ConfigMap, or volume. Compare the
event with [Secrets](secrets.md). Check key names without decoding values:

```bash
kubectl -n "$POPCORN_NAMESPACE" get secret <name> \
  -o go-template='{{range $k,$v := .data}}{{printf "%s\n" $k}}{{end}}'
```

## No Ready GameServers

```bash
kubectl -n "$POPCORN_NAMESPACE" describe fleet browser-fleet
kubectl -n "$POPCORN_NAMESPACE" get gameservers -o wide
kubectl -n "$POPCORN_NAMESPACE" describe gameserver <name>
kubectl -n "$POPCORN_NAMESPACE" logs <browser-pod> -c browser-runtime --tail=200
```

Check browser startup, Agones SDK health, resources, node capacity, image pulls,
runtime security profile, and Agones namespace configuration. Popcorn uses
`portPolicy: None`; host-port range tuning will not fix an unready browser.

## Session creation returns 401 or 403

For client routes, verify the header format is exactly:

```text
Authorization: Bearer <client-id>:<client-secret>
```

Verify the client is active and its `allowedClusters` includes the target
cluster name. Region names and cluster names are different fields.

For control-plane-to-pool-manager failures, verify both sides reference the
same regional `POOL_MANAGER_SERVICE_AUTH_TOKEN` Secret and restart workloads
after environment-backed Secret rotation.

## Session creation returns 503

This usually means no eligible region allocated a browser. Check:

1. requested region names are configured and enabled;
2. the client is allowed to use their cluster names;
3. the pool-manager Service has endpoints;
4. service authentication succeeds;
5. a Ready GameServer exists;
6. Redis and Agones are reachable from the pool manager.

```bash
kubectl -n "$POPCORN_NAMESPACE" get endpoints pool-manager
kubectl -n "$POPCORN_NAMESPACE" get gameservers
kubectl -n "$POPCORN_NAMESPACE" logs deployment/control-plane --tail=200
kubectl -n "$POPCORN_NAMESPACE" logs deployment/pool-manager --tail=200
```

## LiveView returns 404 or 502

Use the session ID—not the full signed URL—to inspect the route:

```bash
# Simple Redis
kubectl -n "$POPCORN_NAMESPACE" exec deployment/redis -- \
  redis-cli GET route:liveview:<session-id>

# Bundled HA Redis
kubectl -n "$POPCORN_NAMESPACE" exec statefulset/redis-ha-node -c redis -- \
  redis-cli -h redis-ha-master GET route:liveview:<session-id>
```

Expected value: `<browser-pod-ip>:6080`.

- Empty route: allocation did not publish state, route expired, wrong Redis,
  or the session was deleted.
- Route exists but 502: gateway cannot reach the pod IP/port, the browser pod
  is gone, or NetworkPolicy/CNI blocks the path.
- 403: the path token is invalid, expired, or for another scope/session.
- HTML loads but WebSocket fails: ingress/proxy upgrade or timeout problem.

## CDP does not connect

Confirm which surface the client should use:

- `cdpUrl` -> restricted `:9222`;
- `cdpInternalUrl` -> trusted full CDP `:9226`;
- x402 automation -> `/cdp-agent` with route-bound access.

Check the matching Redis route, gateway logs, browser proxy logs, and WebSocket
support. A restricted command rejection is different from a failed WebSocket
connection.

## Gateway health works but session routes fail

`/health` proves OpenResty is running; it does not prove Redis lookup or browser
pod reachability. Check gateway Redis DNS/host configuration, route keys,
gateway-to-pod connectivity, and whether gateway replicas all use the same
Redis authority.

## Control plane is unhealthy

```bash
kubectl -n "$POPCORN_NAMESPACE" logs deployment/control-plane --tail=200
kubectl -n "$POPCORN_NAMESPACE" get endpoints control-plane
```

Check Postgres connectivity and TLS, the five database Secret keys, migration
status, region JSON, and admin Secret references. If one replica fails while
another succeeds, compare their image, env, mounts, and node/network path.

## Redis problems

Simple Redis is non-persistent. A restart loses routes. For HA Redis, inspect
Sentinel, the stable master Service, replica state, PVCs, and master-set name.
Do not enable simple and HA Redis simultaneously or point gateway and pool
manager at different authorities.

## TTL cleanup does not run

```bash
kubectl -n "$POPCORN_NAMESPACE" logs deployment/ttl-controller --tail=200
kubectl get lease -A | grep ttl-controller
kubectl auth can-i delete gameservers --as \
  system:serviceaccount:"$POPCORN_NAMESPACE":ttl-controller-sa -A
```

Check leader election, ClusterRole/Binding, GameServer timestamps, control-plane
URL, and `CONTROL_PLANE_SERVICE_AUTH_TOKEN`.

## OTEL logs do not arrive

Check that exactly one endpoint is configured, the DaemonSet runs on browser
nodes, host log paths are mounted, exporter headers exist, and the destination
accepts the selected gRPC or HTTP protocol.

```bash
kubectl -n "$POPCORN_NAMESPACE" get pods -l app=otel-agent -o wide
kubectl -n "$POPCORN_NAMESPACE" logs daemonset/otel-agent --tail=200
```

## Safe escalation data

Collect workload status, Agones state, recent events, chart versions, and
redacted logs as described in [Operations](operations.md#safe-diagnostic-bundle).
Never attach Secret bodies, database credentials, client secrets, payment
payloads, or full session URLs.
