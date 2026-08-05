# High availability

High availability means preserving a useful service through expected failures,
not merely setting every replica count above one. Define the target separately
for new allocations, existing browser connections, lifecycle APIs, and durable
records.

## Availability targets

Document answers to these questions:

- May an active browser session disconnect during a node failure?
- How quickly must new allocation recover after a zone or Redis failure?
- Can the client API be unavailable while existing gateway routes continue?
- What Postgres recovery point and recovery time are required?
- Is regional failover automatic, client-selected, or operator-controlled?

The answers determine whether a single cluster, multi-zone cluster, or multiple
regions are required.

## Component topology

| Component | Production baseline | Failure-domain guidance |
| --- | --- | --- |
| Gateway | 3 replicas | spread across zones and hosts; PDB keeps 2 available |
| Control plane | 2+ replicas | spread replicas; shared Postgres and stable admin session secret |
| Pool manager | 1 initially | protect with fast restart; scale only after concurrency testing |
| TTL controller | 2 replicas with leader election | one active, one standby across nodes |
| Browser Fleet | warm buffer across multiple nodes/zones | dedicated autoscaled pool |
| Redis | HA dependency or managed service | persistence, Sentinel/service failover, zone spread |
| Postgres | managed HA or tested operator solution | backups plus cross-zone/regional recovery |
| Agones | controller deployment installed by tested chart | protect system nodes and API availability |

## Gateway HA

```yaml
gateway:
  replicas: 3
  updateStrategy:
    maxSurge: 1
    maxUnavailable: 0
  podDisruptionBudget:
    enabled: true
    minAvailable: 2
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: gateway
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: gateway
```

The gateway delays shutdown before gracefully stopping OpenResty. Set the delay
long enough for the load balancer to remove the endpoint. Existing WebSockets
on a failed or terminated pod still disconnect; clients must reconnect using
the same live URL while its session remains valid.

## Control-plane HA

Control-plane replicas are stateless apart from shared Postgres and Secrets.
All replicas must use the same:

- region configuration;
- Postgres database;
- `ADMIN_SESSION_SECRET`;
- client/admin auth policy;
- regional pool-manager tokens.

The chart does not currently create a control-plane PDB. Add deployment-layer
policy if your maintenance model requires it and validate it against cluster
upgrade behavior.

## Browser capacity across failures

Place browser nodes in multiple zones and keep enough spare capacity to absorb
one failure domain. `Packed` Agones scheduling can reduce cost but concentrates
workloads; evaluate it against the desired fault tolerance.

The warm buffer should cover:

- normal allocation bursts;
- node provisioning time;
- pods evicted during maintenance;
- the loss of the largest expected failure domain.

Image pre-pulling reduces recovery time but does not create node capacity.

## Redis HA

For chart-owned production Redis:

```yaml
redis:
  enabled: false

redisHa:
  enabled: true
  replica:
    replicaCount: 3
    persistence:
      enabled: true
      storageClass: standard-rwo
      size: 8Gi
  sentinel:
    enabled: true
    quorum: 2
    masterSet: reclaim-master

poolManager:
  redisHost: redis-ha-master

gateway:
  redisHost: redis-ha-master
```

Keep the master-set name stable. Validate PersistentVolume zone behavior,
Sentinel election, the stable master Service, and client reconnect behavior.

An external managed Redis may provide a better operational boundary, but the
operator must verify DNS failover time, network policy, TLS/authentication
requirements, eviction policy, persistence, and maintenance behavior.

## Postgres HA and recovery

Postgres is the durable dependency. Use a managed HA service or a Kubernetes
operator with tested backup and failover. Popcorn does not install or reconcile
Postgres.

Database HA without restore testing is incomplete. Keep point-in-time or
equivalent backups and rehearse the procedure in [Data and recovery](storage.md).

## Multi-region control plane

Configure more than one enabled region when clients may fail over:

```yaml
controlPlane:
  regions:
    - name: us-central1
      clusterName: popcorn-prod-us
      poolManagerUrl: http://pool-manager.popcorn-us.svc.cluster.local
      publicGatewayUrl: https://browser-us.example.com
      enabled: true
      poolManagerAuth:
        secretName: pool-manager-us-service-auth
    - name: europe-west4
      clusterName: popcorn-prod-eu
      poolManagerUrl: https://private-pool-eu.example.internal
      publicGatewayUrl: https://browser-eu.example.com
      enabled: true
      poolManagerAuth:
        secretName: pool-manager-eu-service-auth
```

The control plane tries eligible regions in order. Cross-region pool-manager
URLs must be private and authenticated. Clients with explicit region lists
control their own fallback order. Each region owns its route Redis; do not
create a single high-latency global Redis dependency.

## Failure tests

Run controlled tests with an operator canary, never an unknown production
session:

| Test | Expected result |
| --- | --- |
| delete one gateway pod | health remains available; canary reconnects |
| drain one gateway node | PDB/spread retain serving replicas |
| remove one browser node | affected session may end; Fleet restores warm capacity elsewhere |
| restart pool manager | existing gateway routes continue; new allocation briefly pauses |
| Redis Sentinel failover | clients reconnect and new allocations resume within target |
| stop control-plane replica | remaining replica serves client/admin API |
| make one region unavailable | eligible client request uses next configured region |
| restore Postgres backup | control-plane data is usable in an isolated recovery environment |

Capture recovery time, lost sessions, and manual actions. A test that merely
returns pods to Running does not prove the session path recovered.

## Acceptance checklist

- [ ] Replica counts match the documented SLO.
- [ ] Gateway/control-plane pods span failure domains.
- [ ] Browser capacity survives the chosen node/zone failure.
- [ ] Redis failover and persistence are tested.
- [ ] Postgres failover and restore are tested.
- [ ] PDBs do not deadlock cluster maintenance.
- [ ] Multi-region credentials and routing are isolated.
- [ ] End-to-end canaries validate allocation, LiveView, CDP, extension, and deletion.
