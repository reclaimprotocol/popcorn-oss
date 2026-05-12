# Production Hardening

The OSS quickstart is optimized for a local demo. A production deployment needs stronger controls around identity, network exposure, secrets, runtime isolation, and operations.

## Identity And Access

- Replace local admin credentials before exposing the gateway, and prefer a bcrypt password file or Google OAuth allowlist for `/admin`.
- Use unique client credentials for each integration.
- Keep `/admin/*` endpoints private or behind an authenticated internal network.
- Prefer short session TTLs and explicit session deletion.
- Rotate service tokens on a schedule and after staff or integration changes.

## Network Exposure

- Expose only the gateway publicly.
- Keep Redis, pool manager, analytics, Postgres, and internal services private.
- Use TLS at the edge.
- Restrict Kubernetes API access to operators and automation.
- Use GKE Network Policy or Dataplane V2 policy controls where available.

## Secrets

- Use stable JWT signing keys and keep the private key out of source control.
- Use GCP Secret Manager with External Secrets Operator, or pre-created Kubernetes Secrets managed by your release process.
- Keep local development secrets separate from production namespaces.
- Restart affected workloads after rotation.
- Do not log signed browser URLs, CDP URLs, service tokens, client credentials, or database passwords.

See `docs/secrets.md` for the exact Secret names and keys.

## Images

- Use public images only when they are intended for OSS consumption.
- Pin production images by digest where practical.
- Run vulnerability scans on built images.
- Keep `popcorn-images` pinned and update it intentionally.
- Keep browser runtime and attestor images in sync when attestation is enabled.

## Kubernetes Runtime

- Set resource requests and limits for every service.
- Set `autoscaler.maxReplicas` as a cost guardrail.
- Use dedicated node pools for browser workloads in larger installations.
- Review browser pod privileges against your runtime and sandbox requirements.
- Enable the GKE node prescaler only after Workload Identity, GCP IAM, and target node pool values are configured.

## Data And Retention

- Treat browser pods as ephemeral and untrusted storage.
- Avoid storing sensitive browser artifacts unless a product workflow explicitly requires it.
- Define retention for analytics data.
- Back up production databases if analytics or Metabase are enabled.

## Observability

- Use structured logs with session IDs and pod IDs.
- Redact bearer URLs, path tokens, client secrets, and proof tokens.
- Alert on failed session allocation, high pod startup latency, high browser crash rates, and autoscaler saturation.
- Track image versions and chart values used for each deployment.

## Release Checklist

Before promoting an OSS release into production:

- `helm template` passes for your values.
- Required Secrets exist in the target namespace.
- Gateway health check passes.
- Session create/read/delete flow passes.
- Browser URL opens through the public gateway.
- CDP connection works from your automation environment.
- TTL cleanup removes expired sessions.
- Secret scans and image scans are clean enough for your policy.
