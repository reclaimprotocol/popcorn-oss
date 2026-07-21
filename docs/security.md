# Self-Hosting Security

Popcorn runs each browser session in an ephemeral Kubernetes workload and
exposes access through signed gateway paths. This page is the short operator
checklist for hosting it safely.

## Baseline Controls

- Expose only the gateway publicly unless you have a clear reason to expose the
  control plane.
- Put TLS in front of every public gateway and control-plane endpoint.
- Keep Redis, pool managers, Postgres, and internal service URLs private.
- Use unique client credentials per integration.
- Treat returned session URLs as bearer secrets and avoid logging them.
- Set CPU and memory requests and limits for browser workloads.
- Enable session cleanup with `ttlController` or your own operational cleanup.
- Store secrets in Kubernetes Secrets or an external secret manager.
- Pin production images by digest and scan images before release.

## Trust Boundaries

- Clients call the control-plane `POST /v1/sessions` API with client
  credentials.
- The control plane validates clients, chooses an enabled region, and calls that
  region's pool manager with a service token.
- Pool managers accept only internal control-plane authenticated allocation
  requests.
- The gateway validates signed path tokens before routing browser, CDP, and
  runtime API requests. The optional proof route is session-routed and should be
  exposed only when attestation is enabled and the caller model is understood.
- Redis stores live route state and should be reachable only by platform
  services.
- Browser pods are disposable runtime workloads, not trusted storage.

## Secrets To Manage

Production deployments should manage and rotate:

- gateway JWT private and public keys;
- control-plane client credentials for `/v1/sessions`;
- `CONTROL_PLANE_SERVICE_AUTH_TOKEN`;
- one `POOL_MANAGER_SERVICE_AUTH_TOKEN` per region;
- admin credentials, admin session secret, and optional Google OAuth secret;
- Postgres credentials;
- registry pull credentials, if using private images;
- attestation signing material, if attestation is enabled.

Never commit private keys, client secrets, registry credentials, cloud
credentials, or real production values.

## Session URLs

Session creation returns signed gateway URLs:

- `url`: browser view.
- `cdpUrl`: client-facing CDP endpoint.
- `cdpInternalUrl`: trusted internal CDP endpoint.
- `apiUrl`: browser runtime API endpoint.

Anyone with a live URL can use that route until the token expires or the
session is deleted. Redact full URLs in logs, analytics, tickets, and support
screenshots. Prefer logging `sessionId`, `browserPodId`, `region`, and
`clusterName`.

## Admin Access

Admin endpoints under `/admin` use a separate auth layer from client session
credentials. Supported strategies include token or Basic auth for scripts,
password login, password-file login, and Google OAuth login.

For production:

- prefer a bcrypt htpasswd-style password file or Google OAuth allow lists over
  static `ADMIN_USER` and `ADMIN_PASS` values;
- set `ADMIN_SESSION_SECRET` so browser admin cookies and OAuth state survive
  restarts and replicas;
- restrict Google OAuth by verified email or allowed domain;
- keep `/admin` behind trusted network access when possible;
- do not share admin credentials with client applications.

Pool managers do not expose a public admin UI.

## Kubernetes Hardening

Use standard cluster isolation around the browser fleet:

- run browser containers with the least privileges supported by the runtime;
- avoid hostPath mounts and broad service account permissions;
- use network policies to keep Redis, Postgres, and pool-manager traffic
  internal;
- dedicate browser nodes or node pools when tenant isolation matters;
- set resource requests and limits for browser runtime and attestor containers;
- use digest-pinned runtime images and controlled rollout windows;
- delete sessions promptly when work is complete.

## Advanced: CDP Scope

The gateway exposes two CDP paths with different command scopes:

- `/cdp/<sessionId>/<token>/...`: client-facing CDP path. The nginx config labels
  this "CDP Exposure (Restricted)" and enforces a command allowlist.
- `/cdp-internal/<sessionId>/<token>/...`: full-access CDP path. The nginx config
  labels this "CDP Internal Exposure (Full Access)" and forwards unfiltered CDP.
  The `cdpInternalUrl` / `/cdp-internal` name is legacy naming for this
  full-access CDP surface.

The full-access path uses a distinct token scope and should be used only by
trusted automation or operations tooling, since it is not restricted by the
command allowlist. In OSS v1, do not rely on command-level CDP filtering as the
only security boundary. Use path-token scope, network exposure, client
ownership, and short session lifetime as the primary controls.

## Advanced: Gateway Keys

Gateway path tokens depend on stable JWT keys. Rotating keys invalidates
outstanding browser, CDP, and API URLs unless you deploy an overlap strategy.
Plan key rotation around session lifetime and active workloads.

## Advanced: Attestation

Attestation is optional. When enabled on compatible confidential-computing
infrastructure, the attestor can produce a proof that binds a caller nonce to
the running browser runtime image digest, attestor image digest, and platform
attestation token. See [attestation.md](attestation.md).

## Preflight Checklist

- TLS is configured for public traffic.
- Only intended services are internet reachable.
- Client credentials and admin credentials are distinct.
- Session URLs and path tokens are redacted from logs.
- Redis and Postgres are private.
- Browser workloads have limits, cleanup, and minimal permissions.
- Production images are digest pinned.
- Secrets are stored outside source control.
