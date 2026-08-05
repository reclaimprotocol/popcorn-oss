# Upgrades and uninstall

Upgrade from rendered, reviewed values and a recoverable data state. Do not
combine chart changes, image changes, Secret rotation, and infrastructure
maintenance in one window unless the rollback plan covers all of them.

## Before an upgrade

1. Read the release notes and inspect chart default changes.
2. Back up Postgres and verify the backup job completed.
3. Confirm Redis health and persistence according to the deployment design.
4. Export current Helm values and versions.
5. Render the target platform and browser charts with production overlays.
6. Review database migrations and values schema errors.
7. Confirm new images are available on a clean node.
8. Create a pre-upgrade canary session and record the baseline.

```bash
export POPCORN_NAMESPACE=popcorn

helm -n "$POPCORN_NAMESPACE" get values popcorn-platform --all \
  > /tmp/platform-values-before.yaml
helm -n "$POPCORN_NAMESPACE" get values browser-fleet --all \
  > /tmp/browser-values-before.yaml
helm -n "$POPCORN_NAMESPACE" list
```

These exports can contain internal configuration. Protect them.

## Render the target

```bash
helm lint charts/platform
helm lint charts/browser-fleet

helm template popcorn-platform charts/platform \
  --namespace "$POPCORN_NAMESPACE" \
  -f deploy/platform-base.yaml \
  -f deploy/production/platform.yaml > /tmp/platform-target.yaml

helm template browser-fleet charts/browser-fleet \
  --namespace "$POPCORN_NAMESPACE" \
  -f deploy/browser-base.yaml \
  -f deploy/production/browser.yaml > /tmp/browser-target.yaml
```

Compare with the current rendered manifests, paying special attention to:

- image references;
- Services, Ingresses, and public paths;
- Secret names and keys;
- RBAC and ServiceAccounts;
- database migration Job image;
- Redis identity and persistence;
- Fleet ports, containers, resources, and security profile.

## Upgrade order

Upgrade the platform first:

```bash
helm upgrade popcorn-platform charts/platform \
  --namespace "$POPCORN_NAMESPACE" \
  -f deploy/platform-base.yaml \
  -f deploy/production/platform.yaml \
  --wait --timeout 15m
```

The pre-upgrade migration Job runs before the control plane. Stop if it fails.
Do not bypass it or deploy the new control-plane image manually.

Verify platform health, then upgrade the browser Fleet:

```bash
helm upgrade browser-fleet charts/browser-fleet \
  --namespace "$POPCORN_NAMESPACE" \
  -f deploy/browser-base.yaml \
  -f deploy/production/browser.yaml \
  --wait --timeout 20m
```

Browser Fleet rollout may terminate sessions depending on Agones rollout and
node capacity. Use a staged environment or controlled capacity window for a
new browser digest.

## Post-upgrade acceptance

- migration Job completed;
- platform Deployments and optional DaemonSets are ready;
- Fleet ready capacity recovered;
- a new session can load LiveView and connect through restricted CDP;
- TTL extension and deletion succeed;
- gateway and control-plane health endpoints succeed;
- no new authentication, Redis, Postgres, or image-pull errors appear.

Keep the maintenance window open until a real session lifecycle passes.

## Rollback

Helm rollback can restore Kubernetes manifests:

```bash
helm -n "$POPCORN_NAMESPACE" history popcorn-platform
helm -n "$POPCORN_NAMESPACE" rollback popcorn-platform <revision> --wait
```

It does not reverse Postgres migrations or restore external data. Before
rolling platform code backward, confirm the older version is compatible with
the migrated schema. If not, restore Postgres into the documented recovery
path or deploy a forward fix.

Browser rollback is normally image/manifest-only, but active sessions may
still be interrupted:

```bash
helm -n "$POPCORN_NAMESPACE" history browser-fleet
helm -n "$POPCORN_NAMESPACE" rollback browser-fleet <revision> --wait
```

Do not rotate gateway JWT keys as part of rollback; changing them invalidates
active URLs and makes diagnosis harder.

## Values migrations

The current charts use `sessionExtensions` as the only optional same-pod
service model. Removed list-based sidecar, route, and URL keys fail schema
validation. Fix the values document rather than bypassing schema validation.

Likewise, VNC/LiveView is fixed core behavior and no longer has a streaming
mode. Popcorn does not configure an Agones host-port range.

## Safe uninstall

Uninstalling ends service availability and can delete chart-owned route state.
Before removal:

- stop client allocation;
- delete or allow all active sessions to finish;
- back up Postgres;
- export values and release versions;
- decide whether Redis PVCs and external Secret objects should be retained;
- record DNS and static-IP ownership.

Remove browser workloads before the platform:

```bash
helm -n "$POPCORN_NAMESPACE" uninstall browser-fleet
helm -n "$POPCORN_NAMESPACE" uninstall popcorn-platform
```

Agones is cluster infrastructure. Remove it only when no other Fleet depends on
it:

```bash
helm -n agones-system uninstall agones
```

Deleting the namespace may delete namespace-scoped Secrets and PVCs. Review
retained resources before doing so:

```bash
kubectl -n "$POPCORN_NAMESPACE" get all,pvc,secret,externalsecret
```

External Postgres, managed Redis, DNS zones, global IPs, Secret Manager entries,
and image registries are not removed by Helm.
