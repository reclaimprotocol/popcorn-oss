# Popcorn MCP server

A remote [MCP](https://modelcontextprotocol.io) server that gives an agent
isolated, disposable cloud browsers — with a billing seam, not a billing
implementation.

## What it is

- **Anonymous device identity, no account.** The authorization page generates a
  non-extractable ECDSA P-256 keypair in the browser (IndexedDB) and signs a
  single-use server nonce. The public key's RFC 7638 thumbprint *is* the
  identity. No email, no password, no sign-up; the private key never leaves the
  browser.
- **MCP-native OAuth 2.1 + PKCE.** Dynamic client registration, S256 challenges,
  and a mandatory RFC 8707 `resource` bound at authorize and at token exchange.
  Tokens are audience-bound to `<public URL>/mcp`.
- **Fixed blocks of browser time.** One billed operation buys one server-side
  block (default 10 minutes). Callers cannot request a longer TTL.
- **Idempotent operations.** A call claims its `idempotency_key` atomically
  before doing anything; retries replay the single terminal outcome rather than
  allocating a second browser.
- **Spec-aligned transport.** Origin validation, `MCP-Protocol-Version`
  checking, and one JSON-RPC message per POST.
- **No payment code.** This service has no concept of money, currency,
  checkout, price ids, cards or pricing.

## Tools

| Tool | Billed | Purpose |
| --- | --- | --- |
| `get_balance` | – | Remaining usage credit, or `null` when unmetered |
| `create_browser_session` | ✓ | Isolated session: id, live-view URL, trusted internal CDP URL, expiry |
| `get_browser_session` | – | State of a session the caller owns |
| `get_browser_connection` | – | Agent-facing trusted internal CDP URL, region, expiry |
| `get_live_view` | – | Human-facing live-view URL for a login handoff |
| `verify_runtime` | – | Isolation posture and attestation when available |
| `end_browser_session` | – | End early |
| `list_browser_sessions` | – | Recent sessions for this identity |

`create_browser_session` accepts optional `regions` in nearest-first fallback
order and an optional two-letter `proxy_country`. Proxy URLs and credentials are
never accepted from MCP callers; the selected country uses the deployment-owned
proxy preset.

## Billing is an extension point

This service performs the **browser** effect, so it owns operation idempotency
and recovery. A `BillingProvider` performs the **payment** effect, so it owns
payment idempotency and reconciliation. They are deliberately not one
distributed transaction — they meet at reservation semantics keyed by a shared
`operationId`, which makes retries safe on both sides:

```
claim idempotent operation
        ↓
billing.reserve()
        ↓
create browser with a deterministic session id
        ↓
success → billing.commit()
failure → billing.release()
        ↓
store and replay operation result
```

```ts
type UsageContext = {
  subject: string;
  operationId: string;
  operation: 'create_session';
};

interface BillingProvider {
  getBalance(subject: string): Promise<number | null>;
  reserve(context: UsageContext): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; reason: 'insufficient_credit' | 'billing_unavailable' }
  >;
  commit(reservationId: string): Promise<void>;
  release(reservationId: string): Promise<void>;
}
```

Two implementations ship here (`src/billing.ts`):

- **`NoBillingProvider`** (`MCP_BILLING_PROVIDER=none`, the default) — every
  valid request is allowed and nothing is metered. This is the self-hosting
  default.
- **`ExternalBillingProvider`** (`MCP_BILLING_PROVIDER=external`) — calls
  operator-configured internal HTTP endpoints:

  ```
  GET  {base}/v1/balance/:subject
  POST {base}/v1/reservations
  POST {base}/v1/reservations/:id/commit
  POST {base}/v1/reservations/:id/release
  ```

### Commit is the money-critical step

The browser is created **before** the reservation is committed, so a commit
that fails, times out or is lost to a crash must never be mistaken for success
— the provider would eventually expire the reservation and refund a session
that was actually delivered. Therefore:

- `commit()` throws unless the provider durably confirmed it. `ExternalBillingProvider`
  rejects every non-2xx response; `409` is treated as terminal, everything else
  as retryable.
- Before committing, the obligation is written to `mcp_pending_commits`, so it
  survives a restart.
- A background reconciler (`src/reconcile.ts`) retries pending commits with
  capped exponential backoff until the provider confirms. Commit is idempotent,
  so retrying is always safe.
- The operation result carries `usage_settled`, which is `false` while a commit
  is still outstanding — the operation is never reported as fully settled
  before billing confirms it.
- A terminally refused commit is logged as `UNSETTLED USAGE` and dropped;
  operators should alert on that line.

Providers are expected to accept a **late** commit for a reservation they
already expired, re-debiting it, rather than treating the expiry as final.

A provider may return an opaque purchase hint, which the tool layer passes
through untouched:

```json
{
  "error": "insufficient_credit",
  "next_action": { "type": "external_approval", "url": "https://billing.example/checkout" }
}
```

The MCP server never interprets that payload and never names a payment
provider. If billing is unreachable the operation is refused as
`billing_unavailable` — an outage must not hand out free browser time.

Bring your own provider by implementing the interface and wiring it in
`index.ts`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_PUBLIC_URL` | `http://localhost:3000` | Public origin; OAuth metadata and token audience derive from it |
| `CONTROL_PLANE_URL` | `http://control-plane:3000` | Popcorn control plane |
| `POPCORN_CLIENT_ID` / `POPCORN_CLIENT_SECRET` | – | Control-plane client this server acts as |
| `MCP_TOKEN_SIGNING_KEY` | dev key | Signs tokens and derives subjects; rotating it invalidates both |
| `MCP_SESSION_TTL_SECONDS` | `600` | Fixed block of browser time per billed operation |
| `MCP_OPERATION_LEASE_SECONDS` | `120` | When one retry may recover a crashed operation |
| `MCP_AVAILABLE_REGIONS` | – | Comma-separated region names advertised for nearest-first placement |
| `MCP_BILLING_PROVIDER` | `none` | `none` or `external` |
| `MCP_BILLING_BASE_URL` | – | Billing service base URL (external only) |
| `MCP_BILLING_AUTH_TOKEN` | – | Bearer token for that service |
| `DATABASE_URL` or `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | – | Postgres; unset means in-memory (dev/demo only) |
| `MCP_ALLOWED_ORIGINS` | – | Extra browser Origins allowed on `/mcp` |

## Endpoints

```
GET  /oauth/authorize       consent + device-key challenge (PKCE S256 required)
POST /oauth/decision        verify the signed nonce, redirect with auth code
POST /oauth/token           exchange the code (resource must match)
POST /oauth/register        dynamic client registration
GET  /oauth/revoke          revoke every token on an identity (device-signed)
POST /mcp                   Streamable HTTP, one JSON-RPC message per POST
GET  /health                status, storage mode, billing provider
```

## Storage

Set `DATABASE_URL` and the service uses the transactional Postgres store
(`src/postgres-store.ts`), applying its schema at boot (`bun run db:migrate` to
do it separately). `claimOperation` is a single
`INSERT ... ON CONFLICT DO NOTHING`, so concurrent replicas cannot both win the
same claim. Without `DATABASE_URL` storage is in-memory: fine for local dev,
tests and demos, but claims and session ownership do not survive a restart.

> **Operators:** the default is `MCP_BILLING_PROVIDER=none`, which meters
> nothing. A metered deployment must set `external` and its base URL/token
> explicitly — a missing setting silently grants unmetered browser usage.

## Scope of this build

- Losing the browser device key means losing access to that identity; there is
  deliberately no recovery path, because there is no account to recover.
- Deployment is wired in the platform chart under `mcpServer` (disabled by
  default); see `docs/mcp-server.md`.
