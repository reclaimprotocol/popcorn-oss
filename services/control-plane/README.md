# Control Plane

Central client entry point for Popcorn browser sessions across regions. The
control plane owns client credentials, multi-region session routing, and
analytics storage. Pool managers remain the regional allocators.

## Features

- Client credential authentication with client ID + secret
- Region-prioritized `POST /v1/sessions` session creation
- TTL callback support for expired regional sessions
- PostgreSQL-backed client and session records
- Admin API and UI for clients, sessions, and regional pool state
- Operations analytics: live fleet allocation plus session-lifecycle stats in
  the admin **Analytics** tab

## Configuration

```bash
export POSTGRES_HOST=<postgres-host>
export POSTGRES_USER=analytics_admin
export POSTGRES_PASSWORD=<password>
export POSTGRES_DB=analytics
export CONTROL_PLANE_SERVICE_AUTH_TOKEN=<control-plane-service-token>
export ADMIN_AUTH_STRATEGIES=password,google
export ADMIN_USER=admin
export ADMIN_PASS=<admin-password>
export ADMIN_SESSION_SECRET=<cookie-signing-secret>
export CONTROL_PLANE_ADMIN_TOKEN=<token-for-admin-operations>
export CONTROL_PLANE_REGIONS='[
  {
    "name": "asia-south1",
    "clusterName": "asia-cluster",
    "poolManagerUrl": "http://pool-manager.asia.svc.cluster.local",
    "publicGatewayUrl": "https://asia.popcorn.example",
    "serviceAuthTokenFile": "/app/secrets/pool-managers/asia-south1/POOL_MANAGER_SERVICE_AUTH_TOKEN",
    "enabled": true
  }
]'
```

Prefer per-region pool-manager tokens through `serviceAuthTokenFile` or
`serviceAuthToken` on each region.

### Existing credentialed clients

x402 is an additional public payment path; it does not replace or wrap the
credentialed client API. Existing client rows migrate with
`allowed_clusters = NULL`, which preserves their previous access to every
enabled, non-x402 cluster. Their preconfigured credentials continue to use
`POST /v1/sessions`, `GET/DELETE /v1/session/:id`, and
`PATCH /v1/session/:id/ttl` without a payment header or x402 charge.

The dedicated `x402Only` region is excluded from credentialed routing, even
for legacy unrestricted clients. Newly created clients default to an empty
allowlist until an operator selects clusters; setting an explicit allowlist
changes routing access only and never enables payment requirements.

### Public x402 configuration

The public paid API is disabled by default. Production uses x402 v2, exact
USDC payments on Base, and the CDP facilitator:

```bash
export X402_ENABLED=true
export X402_REGION_NAME=x402-us-central1
export X402_PUBLIC_BASE_URL=https://app.popcorn.reclaimprotocol.org
export X402_PAY_TO=0xYourReceivingAddress
export X402_MANAGEMENT_TOKEN_SECRET=<at-least-32-random-characters>
export X402_BASE_RPC_URL=<https-base-mainnet-rpc-url>
export CDP_API_KEY_ID=<cdp-api-key-id>
export CDP_API_KEY_SECRET=<cdp-api-key-secret>
```

`X402_REGION_NAME` must name exactly one enabled entry in
`CONTROL_PLANE_REGIONS`; x402 allocation never falls back to another region.
`X402_BASE_RPC_URL` is required while x402 is enabled and is used to reconcile
Base authorizations. Keep provider-specific RPC URLs in the management secret
store rather than source-controlled deployment values.
The launch price and time block are fixed at 10,000 atomic USDC ($0.01) and
300 seconds. `X402_MAX_EXTENSION_BLOCKS` caps one extension (default 12), and
`X402_MAX_PAID_BLOCKS` caps total paid lifetime (default 12 / 60 minutes).

For testnet, set `X402_TESTNET=true` to use Base Sepolia and the unauthenticated
x402.org testnet facilitator. `X402_NETWORK` and `X402_FACILITATOR_URL` can be
set explicitly. Base mainnet rejects the testnet-only x402.org facilitator.
`X402_TRUSTED_PROXY_HOPS` defaults to one and selects the client address from
the trusted right side of `X-Forwarded-For`; set it to match the deployed proxy
chain. A shared PostgreSQL limiter defaults to 30 x402 requests per IP per
minute. Keep Cloud Armor enabled as the outer volumetric-abuse boundary.

## Client Session API

For the complete client setup and session creation guide, see
[Reference](../../docs/reference.md).

```http
POST /v1/sessions
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json
```

Request:

```json
{
  "sessionId": "demo-session",
  "ttlSeconds": 900,
  "regions": ["asia-south1", "us-central1"]
}
```

`sessionId` and `regions` are optional. When `regions` is omitted, enabled
regions are tried in configured order. When it is present, only those regions
are tried, in the provided priority order. `ttlSeconds` is optional and is
capped by `SESSION_MAX_TTL_SECONDS`.

Admins can restrict a client to specific clusters by sending
`allowedClusters` when creating it, or by patching the client later. Omitting
the field for a new client defaults to an empty allowlist and denies new session
placement. Setting it to `null` is the explicit legacy mode that grants every
current and future normal cluster. x402-only clusters can never be granted
through this API. The admin Clients UI exposes both modes and requires a
separate confirmation before saving legacy unrestricted access.

```http
PATCH /admin/clients/client_abc123
Authorization: Bearer <admin-token>
Content-Type: application/json

{"allowedClusters":["gcp-us-central1-popcorn"]}
```

Response:

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "https://asia.popcorn.example/browser-fleet-abc/demo-session/<token>/",
  "cdpUrl": "wss://asia.popcorn.example/cdp/demo-session/<token>/",
  "cdpInternalUrl": "wss://asia.popcorn.example/cdp-internal/demo-session/<token>/",
  "apiUrl": "https://asia.popcorn.example/api/demo-session/<token>/",
  "browserPodId": "browser-fleet-abc",
  "expiresAt": "2026-05-26T12:30:00.000Z",
  "region": "asia-south1",
  "clusterName": "asia-cluster"
}
```

`url` is the primary interactive browser view. Deployments can add more response
fields through the pool manager's extra URL templates. In VNC/LiveView mode,
`url` can be overridden to `/liveview/.../liveview.html`; `vncUrl` and
`vncWsUrl` can also be returned as compatibility field names whose values use
`/liveview/.../liveview.html` and `/liveview-ws/...`.

Fetch a session owned by the client:

```http
GET /v1/session/:id
Authorization: Bearer <client-id>:<client-secret>
```

Returns the regional session details (same shape as the creation response,
including `region` and `clusterName`). Unknown sessions, and sessions owned by
another client, return `404`. A session whose region is not configured returns
`409`.

Extend a session owned by the client:

```http
PATCH /v1/session/:id/ttl
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json

{ "extendBySeconds": 900 }
```

Delete a session owned by the client:

```http
DELETE /v1/session/:id
Authorization: Bearer <client-id>:<client-secret>
```

## Public x402 API

No Popcorn account is required. Creation and extension require a durable,
caller-generated `Idempotency-Key`; paid retries with the same request return
the original result and do not charge twice.

```http
POST /v1/x402/sessions
Idempotency-Key: <unique-key>
```

The first request returns `402` and a v2 `PAYMENT-REQUIRED` header for 10,000
atomic USDC on Base. Retry the same request with `PAYMENT-SIGNATURE`. Success
returns an automation-scoped `connectUrl`, restricted `liveViewUrl`, five-minute
expiry, payment transaction, and a high-entropy `managementToken`. The
automation token works only on the dedicated agent CDP route; it cannot be
replayed against internal CDP or runtime API routes, which are never returned.

```http
POST /v1/x402/sessions/:id/extend
Authorization: Bearer <management-token>
Idempotency-Key: <unique-key>
PAYMENT-SIGNATURE: <x402-v2-payload>
Content-Type: application/json

{ "blocks": 3 }
```

Each block costs 10,000 atomic USDC and adds five minutes. Expired sessions
cannot be revived; clients must request an extension with at least four
minutes remaining. A successful extension returns the same `connectUrl` and
`liveViewUrl`; clients can keep the original URLs for the entire session. The
gateway reads the settled paid-access deadline on every request, so an unsettled
extension never grants extra access. The workload TTL is changed
only after settlement; durable reconciliation completes that change if a
post-payment regional call is interrupted. If ambiguous on-chain evidence
outlives the old workload, a subsequently proven payment recreates the x402
workload under the same session ID and URLs and grants the purchased duration
from recovery time. Early termination has no refund:

```http
GET /v1/x402/sessions/:id
DELETE /v1/x402/sessions/:id
Authorization: Bearer <management-token>
```

The management token is derived with an HMAC and only its hash is stored. The
x402 connection JWT is stable and route-bound rather than carrying the paid
deadline. A server-side authorization record enforces the current paid TTL.
Existing credential-based clients retain their existing expiring JWT behavior.

### x402 smoke client

Run `bun run smoke:x402-client` with `X402_SMOKE_BASE_URL` pointed at an enabled
control plane. The client uses a fresh in-memory EVM wallet, performs the real
x402 v2 challenge/sign/retry flow, verifies create and extension pricing,
checks idempotent replay, confirms that the original URLs remain stable, reads status, and
terminates the session. It never prints the generated private key.

`scripts/x402-smoke-dependencies.ts` supplies disposable regional and
facilitator doubles for a no-funds local integration run. That mode validates
the HTTP, SDK, database, lifecycle, and settlement-state integration but does
not replace the Base Sepolia funded-wallet canary required before launch.

## Service APIs

The TTL controller reports expired sessions with `POST /sessions/:id/end`.
Pool managers do not call compatibility validation or session-ingest APIs.

## Admin APIs

Admin routes accept password/file/OAuth browser sessions. `Authorization:
Bearer <CONTROL_PLANE_ADMIN_TOKEN>` is still accepted for compatibility and
automation.

- `GET /admin/regions`
- `GET /admin/sessions`
- `POST /admin/sessions`
- `GET /admin/session/:id`
- `DELETE /admin/session/:id`
- `GET /admin/clients`
- `POST /admin/clients`
- `DELETE /admin/clients/:id`
- `GET /admin/x402/analytics?windowHours=24`

The x402 analytics response calculates revenue only from settled ledger rows
and includes settled payments, unique payers, paid minutes, operation split,
and lifecycle event counts.

The admin UI has three tabs — **Clients**, **Clusters**, and **Analytics**.
The Analytics tab (`GET /admin/ui/analytics?windowHours=1`) shows live fleet
allocation, session-lifecycle metrics, and trend charts (created vs ended,
average duration, outcome split, per-region allocation, top clients) over a
selectable time range (up to 30 days).

Run migrations with:

```bash
bun run db:migrate
```
