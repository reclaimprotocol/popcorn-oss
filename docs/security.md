# Security

Popcorn runs a real browser against untrusted websites. Treat browser workers
as hostile workloads and design the cluster so compromise of one session does
not expose durable data, control-plane credentials, or other sessions.

## Security boundaries

| Boundary | Enforcement |
| --- | --- |
| Client to control plane | client ID/secret and allowed cluster list |
| Operator to admin API | separate admin authentication and network exposure |
| Control plane to pool manager | one regional service token |
| Client to browser route | signed path token with route scope and expiry |
| Gateway to browser | Redis route lookup to an allocated pod IP |
| Browser to cluster | ServiceAccount, CNI, NetworkPolicy, node/runtime isolation |
| Durable state | private Postgres and secret-managed credentials |

No single control is sufficient. A signed URL does not make a privileged
browser safe, and a sandbox does not make leaked credentials harmless.

## Minimum production controls

- Expose the gateway through TLS only.
- Keep pool manager, Redis, Postgres, and Kubernetes/Agones APIs private.
- Keep `/admin` private or behind a separately controlled ingress.
- Use unique client credentials per integration and cluster allow lists.
- Enable TTL cleanup and delete sessions when work completes.
- Pin images and review their provenance before rollout.
- Set browser CPU and memory requests and limits.
- Separate browser workers onto dedicated nodes when tenant isolation matters.
- Redact signed session URLs and Secret values from every logging layer.
- Back up Postgres and test restoration.

## Session URLs are credentials

`url`, `cdpUrl`, `cdpInternalUrl`, `apiUrl`, `vncUrl`, and `vncWsUrl` contain
bearer tokens. Anyone holding a live URL may use that route until it expires,
the route-bound deadline closes, or the session is deleted.

Log identifiers instead:

```text
sessionId
browserPodId
region
clusterName
expiresAt
```

Ingress access logs, tracing attributes, exception messages, support bundles,
and screenshots all need the same redaction policy.

## CDP risk

CDP can inspect pages, read storage, execute JavaScript, navigate the browser,
and interact with downloads.

- `/cdp` applies the restricted client command policy.
- `/cdp-agent` provides automation-scoped full CDP for the x402 lifecycle.
- `/cdp-internal` provides trusted full CDP.

Do not expose full CDP to ordinary clients. Command filtering is defense in
depth, not the primary tenant boundary; token scope, ownership, network
exposure, runtime isolation, and session lifetime remain required.

## Browser workload hardening

The browser chart offers `legacy` and `hardened` security profiles. `legacy`
retains `SYS_ADMIN` for compatibility. `hardened` drops capabilities, disables
privilege escalation, and selects the runtime-default seccomp profile.

Before selecting a profile:

1. test the exact digest-pinned image;
2. test LiveView and both intended CDP paths;
3. test downloads and browser workloads representative of production;
4. test with the chosen runtime class, such as gVisor;
5. verify no sidecar reintroduces broader privileges.

Use dedicated, autoscaled browser nodes. Avoid hostPath mounts, host networking,
privileged containers, or credentials that grant access to durable services.

## Kubernetes identity and RBAC

Review rendered RBAC before install. The pool manager can allocate and delete
GameServers, the TTL controller can delete expired GameServers, and the browser
ServiceAccount can interact with its GameServer and read limited pod/node
metadata.

For public hostile workloads, consider disabling the chart-created browser
ServiceAccount and relying on the minimum Agones SDK identity only after
testing the rendered Fleet and network path. Never grant browser containers
cluster-admin or cloud-wide credentials.

## Network isolation

Use [Networking](networking.md) to keep internal services private. Browser
egress should be either:

- direct public-web egress with private ranges and metadata blocked;
- an approved HTTPS proxy; or
- a stricter destination policy designed for the application.

The bundled NetworkPolicy is a GKE-oriented baseline and must be reviewed for
external Redis, custom DNS, service meshes, or another CNI. Ensure the cloud
metadata address is not reachable from browser workloads.

## Secrets and key rotation

Store production Secrets outside source control. Assign separate owners and
rotation schedules to:

- gateway JWT signing keys;
- regional pool-manager service tokens;
- control-plane lifecycle and admin credentials;
- Postgres credentials;
- browser proxy and registry credentials;
- optional OTLP, attestation, and x402 credentials.

The gateway currently verifies one public key. JWT rotation invalidates active
session URLs unless sessions are drained or the verifier is extended for key
overlap. See [Secrets](secrets.md).

## Public control plane

The control plane contains both client APIs and `/admin`. If clients require a
public control-plane origin:

- use distinct ingress path sets or a separate protected admin ingress;
- enforce TLS and rate limits;
- use Google OAuth allow lists or bcrypt password-file authentication for
  human operators;
- use the admin bearer token only for controlled automation;
- alert on repeated authentication failures and client-credential creation;
- scope clients with `allowedClusters`.

## Supply chain

- Pin platform and browser images by immutable reference.
- Keep the chart version, image digest set, and browser build inputs together
  in the deployment record.
- Verify image signatures when release artifacts provide them.
- Scan service and browser images, including the large browser runtime.
- Restrict registry write access and node pull credentials.
- Roll new browser images through a small Fleet before broad replacement.

See [Images and releases](images-and-releases.md).

## Optional feature boundaries

- Attestation adds a proof service and confidential-node requirements; it does
  not make browser content trustworthy.
- x402 adds public payment and route-bound automation state; keep it in an
  explicit `x402Only` region.
- Session extensions run inside the browser pod and inherit its trust level.
  Review images, env, Secret mounts, privileges, and exposed routes separately.

## Security acceptance checklist

- [ ] Only intended gateway and control-plane paths are public.
- [ ] All public traffic uses TLS/WSS.
- [ ] Redis, Postgres, pool manager, and Kubernetes APIs are private.
- [ ] Browser nodes, runtime profile, RBAC, and egress are reviewed.
- [ ] Full CDP is limited to trusted automation.
- [ ] Client cluster access is explicit.
- [ ] Session URLs and Secret values are redacted.
- [ ] Images and values are pinned and reviewable.
- [ ] Postgres restoration and incident key rotation are rehearsed.
- [ ] Optional components were threat-modeled independently.
