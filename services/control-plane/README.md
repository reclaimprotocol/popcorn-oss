# Control Plane

The control plane is Popcorn's client and operator entry point. It authenticates
clients, selects a region, delegates allocation to that region's pool manager,
and stores client, session, lifecycle, admin, and optional x402 records in
Postgres.

Public API contracts are maintained centrally:

- [Credentialed session and admin API](../../docs/reference.md)
- [Optional x402 API](../../docs/x402.md)
- [Deployment configuration](../../docs/configuration.md)

Do not duplicate request and response examples in this component README.

## Responsibilities

- authenticate client ID/client secret requests;
- enforce each client's cluster allowlist;
- route session operations to enabled regional pool managers;
- keep x402-only regions separate from credentialed-client placement;
- manage admin authentication and the operator UI;
- persist clients, sessions, payment state, and analytics; and
- accept trusted TTL-controller session-end callbacks.

Pool managers remain responsible for Agones allocation, session URL creation,
gateway-token signing, and regional route state.

## Configuration Sources

Helm is canonical for deployed configuration:

- `charts/platform/values.yaml`
- `charts/platform/values.schema.json`
- `charts/platform/templates/control-plane.yaml`

Runtime parsing and validation live in:

- `src/config.ts` for regions and x402;
- `src/database-config.ts` for Postgres and TLS; and
- `src/admin-auth.ts` for interactive and automation admin authentication.

Important environment groups are:

| Area | Variables |
| --- | --- |
| Database | `DATABASE_URL` or `POSTGRES_*`; optional `DATABASE_SSL*` |
| Service auth | `CONTROL_PLANE_SERVICE_AUTH_TOKEN` |
| Regions | `CONTROL_PLANE_REGIONS` with a distinct pool-manager token per region |
| Admin auth | `ADMIN_AUTH_STRATEGIES`, `ADMIN_*`, `CONTROL_PLANE_ADMIN_TOKEN` |
| Session limits | `SESSION_MAX_TTL_SECONDS` |
| Optional x402 | `X402_*` plus facilitator credentials when required |

Store credentials in Kubernetes Secrets or an external secret manager. Do not
put real values in Helm files.

## Internal Service Surface

The TTL controller reports terminal sessions with:

```http
POST /sessions/:id/end
Authorization: Bearer <control-plane-service-token>
```

The control plane calls regional pool managers through their authenticated
`/internal/*` API. Its generic allocation and lifecycle contract is documented
in the [internal API reference](../../docs/reference.md#internal-regional-api).

## Admin Surface

Admin routes support token automation and configured interactive login
strategies. The main route families are:

- `/admin/clients`
- `/admin/regions`
- `/admin/sessions`
- `/admin/x402/analytics`
- `/admin/ui/*`

Admin access is separate from client credentials. Keep it private or behind a
strong authenticated edge; see [Security](../../docs/security.md#public-control-plane).

## Development

From this directory:

```bash
bun install
bun run db:migrate
bun run dev
bun test
```

The service requires Postgres and at least one valid region for end-to-end
allocation. Unit tests cover configuration, admin auth, routing, session
ownership, TTL behavior, analytics, and x402 state transitions.

## Payment Smoke Tests

Run the client smoke flow against an enabled deployment:

```bash
X402_SMOKE_BASE_URL=https://control-plane.example.com \
  bun run smoke:x402-client
```

The smoke client uses a fresh in-memory EVM wallet, validates challenge terms,
tests idempotent replay and extension, confirms stable session URLs, reads
status, and terminates the session without printing the private key.

To verify that an MPP client can pay the same x402 endpoint, configure a funded
test wallet and the independently trusted payment terms described in the
[payment client guide](../../docs/x402-client.md), then run:

```bash
bun run smoke:mpp-client
```

This flow uses `mppx` to recognize the x402 compatibility challenge, enforce
the configured network, asset, payee, and amount, and sign the paid retry.

`scripts/x402-smoke-dependencies.ts` supplies disposable regional and
facilitator doubles for local integration testing. It does not replace a funded
Base Sepolia canary before a production launch.

## Database Migrations

Apply migrations before starting a release that requires a newer schema:

```bash
bun run db:migrate
```

Generate migration files only when intentionally changing the Drizzle schema:

```bash
bun run db:generate
```
