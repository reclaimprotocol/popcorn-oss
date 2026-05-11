# Security

Popcorn isolates each browser session in an ephemeral Kubernetes workload and exposes access through signed gateway paths. This document describes the OSS v1 security model and the limits operators should understand before hosting Popcorn.

## Trust Boundaries

- Client applications call the public gateway.
- The gateway validates path tokens before routing browser, CDP, runtime API, and proof requests.
- The pool manager validates session API credentials before creating, reading, or deleting sessions.
- Redis stores routing state and should remain cluster-internal.
- Browser pods are ephemeral and should not be treated as trusted storage.
- Admin endpoints are for trusted operators only.

## Session API Credentials

Client session API credentials are configured for the `/session` endpoint:

```http
Authorization: Bearer <client-id>:<client-secret>
```

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
- session API client credentials (for `/session`);
- registry pull credentials, if needed;
- attestation signing material, if attestation is enabled;
- analytics or observability secrets, if those optional services are enabled.

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

- Add a root `LICENSE` before OSS launch.
- Use TLS for gateway traffic.
- Keep admin endpoints behind trusted access controls.
- Keep Redis and internal services private.
- Use digest-pinned runtime images.
- Ensure the AI-agent component is excluded from OSS v1 deployments and export paths.
- Use your own registry and credentials.
- Set session TTLs and resource limits.
- Run dependency and container scans as part of release.
