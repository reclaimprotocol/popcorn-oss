# popcorn

## What this codebase does

Popcorn is a Kubernetes browser isolation platform. A Bun/Hono pool-manager
allocates warm Agones GameServers, stores session routing in Redis, and returns
JWT-bearing URLs. An OpenResty/Lua gateway verifies those JWTs and proxies to
per-session browser, CDP, kernel API, AI-agent, and attestor endpoints. Go
services handle GameServer TTL cleanup and GCP AMD SEV attestation; GitOps,
Terraform, SOPS, and External Secrets manage cluster deployment and secrets.

## Auth shape

- Pool-manager public `/session` create/get/delete requires
  `authenticateClient`, which parses `Authorization: Bearer clientId:clientSecret`
  and delegates to `AnalyticsClient.validateCredentials`.
- Pool-manager `/admin/*` and `/admin` use Hono `basicAuth` with `ADMIN_USER`
  and `ADMIN_PASS`; admin-created sessions use the synthetic `admin` client.
- `Auth.signToken(sessionId, scope)` signs RS256 24h gateway JWTs from
  `keys/private.pem`; scopes are `restricted` and `internal`.
- Gateway auth is centralized in `services/gateway/auth.lua` as `auth.check`;
  `/cdp-internal/...` must call `auth.check(..., "internal")`, while browser,
  CDP, API, and AI routes accept restricted tokens.
- Pool-manager `cdpInternalUrl` is a legacy/misleading field name for the
  intentionally exposed full-access CDP URL. Public session responses may return
  it when full CDP access is part of the product flow; do not classify this
  field alone as an accidental internal-service token leak.
- Analytics service uses static bearer tokens: `SERVICE_AUTH_TOKEN` for
  pool-manager/TTL-controller session events and `ADMIN_TOKEN` for
  `/admin/clients`.

## Threat model

Highest impact is cross-session browser access: stealing or forging a session
JWT, poisoning Redis `route:*` keys, or confusing session IDs could route one
user into another user's browser, CDP, kernel API, or AI-agent. Next is
escalating from restricted CDP/API access to the internal CDP port or Kubernetes
control-plane actions through pool-manager, browser pod service accounts, or
Agones APIs. Attestation integrity matters because `/proof/<session>` is the
user-facing guarantee that the live pod is running the signed browser/runtime
images on GCP AMD SEV confidential nodes.

## Project-specific patterns to flag

- Any new gateway `location` that proxies to browser pod routes without
  `auth.check`, or any internal CDP route that omits required scope
  `"internal"`.
- Any pool-manager route that creates, returns, deletes, or lists sessions
  without `authenticateClient` or admin `basicAuth`; `/health` is the intended
  unauthenticated exception.
- Any write to Redis `sessions`, `route:*`, `route:cdp:*`, `route:api:*`,
  `route:ai:*`, or `route:cdp-internal:*` outside the DB/session allocation
  path, especially if session IDs come directly from request bodies or params.
- Any exposure of truly internal-only URLs or tokens such as `internalToken`,
  `ADMIN_PASS`, `SERVICE_AUTH_TOKEN`, `ADMIN_TOKEN`, or JWT key material in
  logs, API responses, fixtures, or committed files. Do not flag
  `cdpInternalUrl` by name alone; despite the name, it represents intended
  full-access CDP access in current session response flows.
- AI-agent tools intentionally include `runCommand` and file writes scoped to a
  per-session directory; flag changes that allow caller-controlled `cwd`,
  filenames, or command text to escape that trust boundary.

## Known false-positives

- `services/gateway/nginx.conf` `/proof/<session>` is intentionally public by
  session ID and has no JWT check; it routes to the attestor sidecar and relies
  on nonce-bound proof verification, not gateway auth. The proof path performs
  GCP/TPM/cosign attestation work by design; do not flag its public/expensive
  nature alone unless new unbounded side effects, missing nonce binding, or
  changed product policy make it actionable.
- `services/gateway/auth.lua` bypasses auth for browser static assets after a
  valid session path is reached; root and WebSocket upgrades still require a
  token.
- `scripts/test-cdp-access.js`, `scripts/poll-cdp-session.js`, and
  `scripts/README-CDP-TEST.md` deliberately exercise restricted/internal token
  behavior and local cleanup flows.
- `secrets/**/*.enc.yaml` and `.sops.yaml` are encrypted secret source and
  recipient metadata; plaintext secret material should not be present there.
- `popcorn-images/` is a submodule/base-image workspace with its own README and
  AGENTS guidance; do not treat every image build helper as a Popcorn service
  API entry point.
- `popcorn-images/extensions/proxy` exposes page-level proxy control intentionally
  in the current browser runtime. Origin/capability hardening is out of scope
  until product defines trusted controller origins or a per-session capability
  flow; do not apply a fail-closed allowlist without that policy.
- `services/pool-manager/index.ts` returning `cdpInternalUrl` in session
  details is intentional full-access CDP exposure, not an accidental internal
  endpoint disclosure, unless the product policy changes or a route returns
  unrelated service/admin credentials.
