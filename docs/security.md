# Security

Popcorn isolates each browser session in an ephemeral Kubernetes workload and exposes access through signed gateway paths. This document describes the OSS v1 security model and the limits operators should understand before hosting Popcorn.

## Trust Boundaries

- Client applications call the public gateway.
- The gateway validates path tokens before routing browser, CDP, runtime API, and proof requests.
- The pool manager validates session API credentials before creating, reading, or deleting sessions.
- Redis stores routing state and should remain cluster-internal.
- Browser pods are ephemeral and should not be treated as trusted storage.
- Admin endpoints are for trusted operators only.

## Admin Authentication

Admin endpoints under `/admin` use a separate admin auth layer from the client
session API. Deployments can enable one or more admin strategies:

- username/password through HTTP Basic auth for scripts;
- username/password browser login backed by the same credential source;
- Google OAuth browser login.

The default username/password source is still `ADMIN_USER` / `ADMIN_PASS` for
backward compatibility. Production deployments should prefer a mounted
htpasswd-style bcrypt password file or Google OAuth with explicit allow rules.
Google users must have verified email and match either an allowed email or an
allowed domain. Admin browser sessions are stored in signed, HTTP-only cookies
and should be protected by TLS outside local development. Configure
`ADMIN_SESSION_SECRET` for Google OAuth or password-file browser login so
session cookies and OAuth state remain valid across restarts and replicas.

## Session API Credentials

Client session API credentials are required for the `/session` endpoint:

```http
Authorization: Bearer <client-id>:<client-secret>
```

In the current pool-manager implementation, these credentials are not loaded
from a local `SESSION_AUTH_CLIENTS` map. The pool manager calls the analytics
service `POST /validate` endpoint and authenticates that service call with
`ANALYTICS_AUTH_TOKEN`. Deployments that expose `/session` therefore need an
analytics service endpoint plus Postgres-backed client records, even if the
analytics UI or dashboards are otherwise optional.

Local Kind smoke tests should use `/admin/session` with local admin credentials (`admin:admin`) instead of client credentials.

Recommendations:

- Use unique client credentials per integration.
- Store client secrets outside source control.
- Rotate credentials on a regular schedule.
- Prefer short-lived or revocable credentials when integrating with your own auth layer.
- Return the minimum session details needed by untrusted callers.

## Gateway Path Tokens

Session creation returns URLs containing signed path tokens:

- Browser view token in `url`.
- Restricted CDP token in `cdpUrl`.
- Internal CDP token in `cdpInternalUrl`.
- Runtime API token in `apiUrl`.

Treat these URLs as bearer secrets. Anyone with a live URL can use that route until the token expires or the session is deleted.

Recommended controls:

- Terminate TLS in front of the gateway for non-local deployments.
- Keep path-token signing keys stable during rollouts.
- Rotate signing keys with an overlap plan if long-lived sessions are supported.
- Avoid writing returned URLs to shared logs.
- Delete sessions when work is complete.

## CDP Access

The gateway exposes two CDP paths:

- `/cdp/<sessionId>/<token>/...`: client-facing endpoint.
- `/cdp-internal/<sessionId>/<token>/...`: trusted internal endpoint.

The internal endpoint uses a distinct token scope. It should only be used by trusted automation or operational tools.

In OSS v1, do not rely on command-level CDP filtering as the only security boundary. The primary controls are session ownership, path-token scope, network exposure, and short session lifetime.

## Browser Isolation

Each session is allocated to a dedicated Agones GameServer pod. Operators should still configure normal Kubernetes isolation:

- run browser workloads with the least privileges supported by the runtime;
- set CPU and memory requests and limits;
- keep Redis, pool manager, and internal services off the public internet;
- use network policies when available;
- avoid mounting host paths or broad service account permissions into browser pods;
- expire idle sessions through the TTL controller.

## Secrets

Public quickstarts should not require production secret tooling. Local development uses generated development keys and local-only credentials.
For OSS installations, store production secrets in Kubernetes Secrets or your own external secret manager.

Production deployments should manage:

- gateway JWT private and public keys;
- analytics-backed session API client credentials (for `/session`);
- the analytics service token used by pool-manager validation calls;
- pool-manager admin credentials, admin session secret, and optional Google OAuth client secret;
- registry pull credentials, if needed;
- attestation signing material, if attestation is enabled;
- observability secrets, if optional observability services are enabled.

Never commit private keys, client secrets, registry credentials, or cloud credentials.

## Attestation

Attestation is optional in OSS v1. When enabled on compatible confidential-computing infrastructure, the attestor can produce a proof that binds:

- caller-provided nonce;
- running browser runtime image digest;
- running attestor image digest;
- platform attestation token.

See [attestation.md](attestation.md).

## Logging

Avoid logging:

- full session URLs;
- path tokens;
- client secrets;
- admin credentials;
- proof tokens unless needed for explicit verification workflows.

Prefer structured logs with session IDs and pod IDs, while redacting tokens.

## Public Deployment Checklist

- Confirm the root `LICENSE` matches the intended release license.
- Use TLS for gateway traffic.
- Keep admin endpoints behind trusted access controls.
- Keep Redis and internal services private.
- Use digest-pinned runtime images.
- Keep private deployment extensions out of OSS release manifests.
- Use GHCR or your own GCP Artifact Registry mirror with digest-pinned images.
- Set session TTLs and resource limits.
- Run dependency and container scans as part of release.
