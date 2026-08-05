# Data, backup, and recovery

Popcorn deliberately separates durable control-plane data from short-lived
runtime route state. Back up them according to their role instead of treating
every Kubernetes object as equally durable.

## Data ownership

| Store | Data | Durability expectation |
| --- | --- | --- |
| Postgres | clients, session records, lifecycle metadata, admin/analytics data, x402 state when enabled | Durable and backed up |
| Redis | active session allocation records, route keys, access deadlines | Available for active sessions; recoverable by ending/recreating sessions |
| Kubernetes / Agones | current Fleet and GameServer objects | Reconciled from Helm and controllers |
| Browser pod filesystem | per-session browser profile and temporary output | Disposable |
| Helm values and manifests | desired deployment state | Version controlled outside the cluster |

## Postgres

The platform chart does not install Postgres. Provide a managed or
operator-managed database through `analytics-db-secret`:

```text
host
port
database
username
password
```

Enable `controlPlane.databaseSsl` for production. Use the CA value or file
settings when the database certificate is not already trusted by the image.

The chart runs `bun run db:migrate` as a Helm pre-install/pre-upgrade hook and
an Argo CD sync hook before the control plane rolls out. A failed migration
blocks the release and must be investigated; do not bypass it by manually
starting a newer control-plane image.

### Postgres backup policy

Use the database platform's native physical or logical backups. At minimum:

- take automated backups on a defined schedule;
- retain a restore point from before every Popcorn upgrade;
- encrypt backup storage and restrict restore permissions;
- test restoration into a separate database;
- record database engine version, Popcorn image version, and migration level
  with each upgrade backup.

The chart cannot verify your external database backups.

## Redis choices

### Simple Redis

`redis.enabled=true` creates one Deployment with no persistent volume. It is
appropriate for Kind and evaluation. A restart loses route state and interrupts
active sessions. `redis.replicas` must remain `1`; multiple independent Redis
pods behind one Service are not replication.

### Bundled HA Redis

`redisHa.enabled=true` installs the bundled Bitnami Redis dependency with
replication, Sentinel, and persistent volumes. Keep
`redisHa.sentinel.masterSet` stable across upgrades because it is Sentinel's
state identity.

The default values are a starting topology, not a substitute for restore and
failover tests. StorageClass behavior, zone placement, volume snapshots, and
node disruption are cluster responsibilities.

### External Redis

Disable both bundled choices and point `poolManager.redisHost` and
`gateway.redisHost` at the managed endpoint. Confirm DNS, TLS or network
controls, latency, eviction policy, and failover behavior. The current service
clients expect Redis connectivity on port 6379.

## What happens when Redis is lost

Existing browser pods may still be running, but the gateway cannot resolve
their session routes and allocation state is unavailable. Recovery should
prioritize consistency:

1. stop new allocations or put the client API into maintenance;
2. restore Redis or deploy a clean authoritative instance;
3. terminate browser GameServers whose route state cannot be proven;
4. remove stale session records through the supported lifecycle paths;
5. create fresh sessions and verify route TTLs;
6. reopen allocation.

Do not reconstruct route keys from untrusted client URLs.

## Browser state

Browser workers are intentionally ephemeral. Do not store durable customer
data only inside a browser pod. Session deletion, TTL cleanup, node drain, Fleet
rollout, or cluster failure can remove it.

If an extension produces durable artifacts, upload them to an external store
before ending the session and document that store's own retention and security
policy.

## Desired-state backup

Keep these outside the cluster:

- exact chart and image versions;
- platform and browser values;
- DNS and static-IP configuration;
- Secret-manager references, not plaintext Secret values;
- Postgres and Redis service configuration;
- runbooks for key rotation and database restore.

Before an upgrade, capture read-only evidence:

```bash
helm -n popcorn get values popcorn-platform --all > platform-values-before.yaml
helm -n popcorn get values browser-fleet --all > browser-values-before.yaml
helm -n popcorn list
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
```

These exports may reveal internal configuration. Store them as operational
artifacts with appropriate access controls.

## Recovery order

For a regional rebuild:

1. restore or provision Postgres;
2. restore the required Secrets and stable gateway JWT keys;
3. install Agones;
4. restore Redis according to the chosen RPO, or start clean with no active
   sessions;
5. install the platform chart and allow migrations to finish;
6. install the browser Fleet;
7. restore DNS and load-balancer routing;
8. create a new client-scoped acceptance session;
9. verify deletion and TTL cleanup.

If the gateway JWT private key changes, old signed session URLs are invalid.
That is safe for a clean recovery but disruptive during an in-place repair.

## Recovery test

At least quarterly for a production service:

- restore Postgres into an isolated environment;
- render and install the pinned chart versions;
- prove a client record and admin access can be read;
- create and delete a new browser session;
- simulate Redis loss according to the documented recovery path;
- record recovery time and any manual steps.

Use [High availability](high-availability.md) for failure handling that should
not require full recovery.
