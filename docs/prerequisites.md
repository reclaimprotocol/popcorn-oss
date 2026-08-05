# Requirements and planning

Use this page before creating a production cluster. It describes the currently
supported deployment rather than every environment the charts might render on.

## Support boundary

| Environment | Status | Intended use |
| --- | --- | --- |
| GKE Standard | Supported production target | Internet-facing or private production deployments |
| Kind | Supported local workflow | Evaluation, development, and smoke tests |
| Other Kubernetes distributions | Not currently validated | Porting and community testing |
| GKE Autopilot | Not currently validated | Do not assume browser runtime or Agones compatibility |

The browser runtime image is Linux/amd64. Schedule browser GameServers only on
compatible nodes. The platform services are less resource intensive and may
share a general-purpose system node pool.

## Operator tools

The installation workflow requires:

- a working `kubectl` context with cluster-admin-equivalent installation
  permissions;
- Helm 3;
- `jq` and OpenSSL for the documented bootstrap and verification commands;
- access to the image registry containing the Popcorn images;
- `gcloud` when using GKE resources and Google Secret Manager;
- Docker and Kind only for the local quickstart.

Run these before changing a cluster:

```bash
kubectl version
helm version
kubectl auth can-i create deployments --namespace popcorn
kubectl auth can-i create clusterrole
```

## Cluster dependencies

Production requires:

- Agones `1.57.0`, installed once per cluster;
- a Postgres database for the control plane;
- Redis for active session and gateway route state, supplied by the simple
  chart deployment, the HA dependency, or an external service;
- a default StorageClass when using the bundled HA Redis persistence;
- a working CNI with pod-to-pod and pod-to-Service connectivity;
- DNS and TLS termination for every public endpoint.

External Secrets Operator is optional. The bundled ExternalSecret templates
expect a cluster-scoped store named `gcpsm`; use direct Kubernetes Secrets when
that integration is not installed.

## GKE baseline

Use a VPC-native GKE Standard cluster with:

- Workload Identity enabled when workloads access Google APIs;
- Shielded nodes;
- a general-purpose system node pool for platform services;
- a separately scalable browser node pool;
- enough ephemeral disk to pull the browser image on every browser node;
- cluster autoscaling sized for `autoscaler.maxReplicas`;
- a global static IP and DNS record for the gateway when using the chart's GCE
  Ingress resources.

Confidential nodes and the confidential-computing device plugin are required
only for [attestation](attestation.md). They should not be part of the initial
deployment unless attestation is a hard requirement.

## Capacity inputs

Do not size from replica counts alone. Record these inputs:

- expected concurrent browser sessions;
- desired number of immediately available warm sessions;
- browser CPU and memory requests and limits;
- average session duration and peak creation rate;
- image size and acceptable cold-start time;
- number of zones and maximum unavailable nodes;
- gateway concurrency and WebSocket duration;
- Postgres connection and retention requirements.

The FleetAutoscaler keeps a buffer of ready GameServers. Node autoscaling must
have room to satisfy the Fleet ceiling; increasing `autoscaler.maxReplicas`
without node capacity does not increase usable capacity.

## Network decisions

Decide before installation:

- public or private gateway;
- public, private, or separately protected control plane;
- DNS names and static IP resources;
- browser egress policy and whether an HTTPS proxy is required;
- whether the cluster supports the chart's optional egress NetworkPolicy;
- whether platform and browser workloads share a namespace.

Read [Networking](networking.md) before choosing non-default exposure.

## Data and security decisions

Before production, assign ownership for:

- Postgres backups and restore testing;
- Redis persistence and recovery expectations;
- gateway JWT key generation and rotation;
- admin and client credential issuance;
- one pool-manager service token per region;
- container image pinning and vulnerability review;
- session URL redaction in logs and support systems.

See [Data and recovery](storage.md), [Secrets](secrets.md), and
[Security](security.md).

## Readiness checklist

- [ ] GKE Standard and amd64 browser nodes are available.
- [ ] Agones, Postgres, Redis, DNS, and TLS ownership is decided.
- [ ] Browser capacity and node autoscaling ceilings agree.
- [ ] Production image references are pinned.
- [ ] Required Secrets can be created without committing plaintext values.
- [ ] A Postgres backup and restore mechanism exists.
- [ ] Only intended endpoints will be public.
- [ ] An operator can run the acceptance test after deployment.

Continue with [Production installation](deployment.md).
