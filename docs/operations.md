# Operations

This runbook covers normal health checks, scaling, session cleanup, and
maintenance. Use [Troubleshooting](troubleshooting.md) once a check fails and
[Upgrades](upgrades.md) for version changes.

## Establish a healthy baseline

Record the expected enabled components and replica counts. For a standard
single-region deployment:

```bash
export POPCORN_NAMESPACE=popcorn

kubectl -n "$POPCORN_NAMESPACE" get deploy,ds,job,pods
kubectl -n "$POPCORN_NAMESPACE" get fleet,fleetautoscaler,gameservers
kubectl -n "$POPCORN_NAMESPACE" get svc,ingress,endpoints
helm -n "$POPCORN_NAMESPACE" list
```

A healthy system has:

- available platform replicas;
- a successful control-plane migration Job for the installed version;
- a Fleet whose ready/allocated counts match demand;
- Ready GameServers at or above the configured warm buffer;
- gateway and control-plane health endpoints returning success;
- no recurring restarts or unschedulable browser pods.

## End-to-end canary

Kubernetes readiness is necessary but insufficient. Maintain a dedicated test
client scoped to one non-x402 cluster and regularly:

1. create a short-lived session;
2. load the LiveView URL;
3. connect through restricted CDP;
4. extend the TTL once;
5. delete the session;
6. confirm the GameServer and Redis routes disappear.

Do not log the returned URLs. Record only IDs, timings, region, status, and
failure stage.

## Routine checks

### Capacity

```bash
kubectl -n "$POPCORN_NAMESPACE" get fleet browser-fleet
kubectl -n "$POPCORN_NAMESPACE" get fleetautoscaler browser-autoscaler
kubectl -n "$POPCORN_NAMESPACE" get gameservers -o wide
kubectl get nodes -L topology.kubernetes.io/zone
```

Watch ready, allocated, reserved, and pending GameServers. A high Fleet ceiling
does not help when nodes cannot scale or browser requests do not fit.

### Platform dependencies

```bash
kubectl -n "$POPCORN_NAMESPACE" logs deployment/pool-manager --tail=100
kubectl -n "$POPCORN_NAMESPACE" logs deployment/popcorn-gateway --tail=100
kubectl -n "$POPCORN_NAMESPACE" logs deployment/control-plane --tail=100
kubectl -n "$POPCORN_NAMESPACE" get events --sort-by=.lastTimestamp | tail -50
```

Monitor Postgres and Redis with the tools provided by those services. Popcorn
health endpoints do not replace database backup, replication, or latency
monitoring.

## Scaling browser capacity

Capacity has two layers:

1. FleetAutoscaler values decide desired GameServer count.
2. The Kubernetes node autoscaler supplies nodes for those pods.

Tune:

- `autoscaler.bufferSize` for immediately available warm sessions;
- `autoscaler.minReplicas` for the steady floor;
- `autoscaler.maxReplicas` for the regional cap;
- browser CPU/memory requests for node packing;
- browser node-pool min/max nodes for actual schedulable capacity.

Change one layer at a time and observe allocation latency, Pending pods, image
pull duration, node provisioning, and cost.

## Scaling platform services

- Gateway: scale horizontally and add a disruption budget/topology spread.
- Control plane: scale horizontally only with a stable
  `ADMIN_SESSION_SECRET` and shared Postgres.
- Pool manager: start with one replica unless allocation concurrency and
  behavior have been tested with more; Redis and Agones remain shared
  dependencies.
- TTL controller: leader election allows standby replicas, but one active
  reconciler performs cleanup.

See [High availability](high-availability.md) before changing production
replica topology.

## Session cleanup

Enable `ttlController.enabled=true`. It watches Agones GameServers, deletes
expired ones, and reports lifecycle completion to the control plane. Verify:

```bash
kubectl -n "$POPCORN_NAMESPACE" rollout status deployment/ttl-controller
kubectl -n "$POPCORN_NAMESPACE" logs deployment/ttl-controller --tail=200
kubectl get lease -A | grep ttl-controller
```

Clients should still explicitly delete completed sessions. TTL cleanup is the
safety net, not a replacement for normal lifecycle calls.

## Node maintenance

Before draining a browser node:

1. ensure another zone/node has warm capacity;
2. stop new placement on the node;
3. identify allocated GameServers on it;
4. allow short sessions to finish or terminate them deliberately;
5. drain according to the cluster maintenance policy;
6. confirm Fleet capacity recovers elsewhere;
7. run the canary.

Browser pods are ephemeral. Node drain may terminate active user sessions; set
maintenance expectations accordingly.

## Redis maintenance

For bundled HA Redis, inspect Sentinel and replica health before disruption.
Keep `redisHa.sentinel.masterSet` unchanged. Test failover with canary sessions
before and after maintenance.

For the simple Redis Deployment, any restart loses route state. Treat the
maintenance as an active-session outage or migrate to HA/external Redis first.

## Postgres maintenance

Control-plane writes and migrations require Postgres. Before database
maintenance:

- take and verify a backup;
- stop or drain session lifecycle writes if the maintenance is disruptive;
- confirm connection/TLS changes in a non-production database;
- restart the control plane after credential or CA changes;
- run client and admin read/write checks.

## Safe diagnostic bundle

Capture metadata without Secret bodies or session URLs:

```bash
mkdir -p /tmp/popcorn-diagnostics
kubectl -n "$POPCORN_NAMESPACE" get deploy,ds,job,pods -o wide \
  > /tmp/popcorn-diagnostics/workloads.txt
kubectl -n "$POPCORN_NAMESPACE" get fleet,fleetautoscaler,gameservers -o wide \
  > /tmp/popcorn-diagnostics/agones.txt
kubectl -n "$POPCORN_NAMESPACE" get events --sort-by=.lastTimestamp \
  > /tmp/popcorn-diagnostics/events.txt
helm -n "$POPCORN_NAMESPACE" list \
  > /tmp/popcorn-diagnostics/helm.txt
```

Review logs and rendered values for credentials and signed URLs before sharing
them.

## Operational checklist

- [ ] Canary session lifecycle succeeds.
- [ ] Warm GameServer buffer is available.
- [ ] Browser node autoscaling has headroom.
- [ ] Gateway/control-plane replicas and disruption policy match the SLO.
- [ ] Redis and Postgres health and backups are current.
- [ ] TTL cleanup is active.
- [ ] Image and Secret rotation dates are tracked.
- [ ] Recent version and values are recoverable from version control.
