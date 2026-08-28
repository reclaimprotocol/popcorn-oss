# mcp-server

A remote **Model Context Protocol** server that lets any MCP client (Claude,
Cursor, agent marketplaces) start isolated Popcorn browser sessions and pay for
them with a card — no wallet, no private keys, no `402` handshake.

## Design

- **MCP-native OAuth 2.1 + PKCE.** Clients register dynamically, the human
  approves once in a browser, and the access token carries a stable
  pseudonymous subject.
- **Anonymous device identity, no account.** The authorization page generates
  a non-extractable ECDSA P-256 keypair in the browser (IndexedDB) and signs a
  single-use server nonce. The public key's RFC 7638 thumbprint *is* the
  identity that owns the credit balance — no email, no password, no sign-up,
  and the private key never leaves the browser. Clearing site data or using
  another browser starts a new, empty balance. The auth header identifies *whose* balance and policy
  apply; it never itself authorizes a charge.
- **Popcorn credit, not a wallet.** A closed-loop prepaid balance in USD cents:
  usable only for Popcorn sessions, non-transferable, non-withdrawable, no
  crypto.
- **One payment verb.** `top_up` returns a Stripe Checkout URL; the human pays;
  the webhook credits that exact OAuth subject. The agent never sees card data.
- **Idempotent operations, not just charges.** A call claims its
  `idempotency_key` atomically before charging or allocating, so two
  simultaneous retries can never produce two browsers; later retries replay
  the first terminal outcome, and a retry after a refunded failure cannot
  yield a free session. Credits are keyed on
  the Stripe event; the top-up record is written before Checkout is created so
  a fast webhook is never dropped (unmatched events get a 503 so Stripe
  retries).
- **Spec-aligned transport.** Tokens are audience-bound to `<public URL>/mcp`
  (RFC 8707 `resource` is **required** at authorize, stored on the
  authorization code, and must match exactly at token exchange), Origin is validated,
  `MCP-Protocol-Version` is checked, and JSON-RPC batches are rejected — one
  message per POST.

## Tools

| Tool | Paid | Purpose |
| --- | --- | --- |
| `get_balance` | – | Balance, session price, how many sessions it buys |
| `top_up` | – | Stripe Checkout URL for the human to approve |
| `create_browser_session` | ✓ | Isolated session: id, live-view URL, CDP URL, expiry, amount charged |
| `get_browser_session` | – | State of a session the caller owns |
| `get_browser_connection` | – | Agent-facing CDP URL, region, expiry |
| `get_live_view` | – | Human-facing live-view URL for a login handoff |
| `verify_runtime` | – | Isolation posture and attestation document when available |
| `extend_browser_session` | ✓ | The paid boundary; returns `insufficient_credit` with a `top_up` hint |
| `end_browser_session` | – | End early (no refund) |
| `list_browser_sessions` | – | Recent sessions for this identity |

Every session is a fresh, isolated browser: no local Chrome profile, cookies,
or saved passwords. Logins are a **handoff** — the agent sends the human the
live-view URL and never asks for credentials.

## Endpoints

```
GET  /.well-known/oauth-authorization-server
GET  /.well-known/oauth-protected-resource
POST /oauth/register        dynamic client registration (no client secret)
GET  /oauth/authorize       consent + device-key challenge (PKCE S256 required)
POST /oauth/decision        verify the signed nonce, redirect with auth code
POST /oauth/token           authorization_code -> access token
POST /mcp                   MCP JSON-RPC (Bearer token required)
POST /stripe/webhook        checkout.session.completed -> credit
GET  /health
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_PUBLIC_URL` | `http://localhost:3000` | Issuer used in OAuth metadata |
| `CONTROL_PLANE_URL` | `http://control-plane:3000` | Popcorn control plane |
| `POPCORN_CLIENT_ID` / `POPCORN_CLIENT_SECRET` | – | Operator client this adapter acts as |
| `DATABASE_URL` | – | Postgres; unset means in-memory (dev/demo only) |
| `MCP_ALLOWED_ORIGINS` | – | Extra browser Origins allowed on `/mcp` |
| `MCP_TOKEN_SIGNING_KEY` | dev key | **Set in production**; signs access tokens |
| `MCP_SESSION_PRICE_USD_CENTS` | `5` | Price of one session |
| `MCP_SESSION_TTL_SECONDS` | `600` | Default session lifetime |
| `MCP_MIN_TOP_UP_USD_CENTS` | `5` | Minimum card charge (one session) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | – | Required for `top_up` |
| `MCP_TOP_UP_SUCCESS_URL` / `MCP_TOP_UP_CANCEL_URL` | – | Checkout return URLs |

## Run

```bash
bun install
bun run dev
bun test
```

## Storage

Set `DATABASE_URL` and the service uses the transactional Postgres store
(`src/postgres-store.ts`), applying its schema at boot (`bun run db:migrate`
to do it separately). Without it, storage is in-memory — fine for local dev,
tests and demos, and the service refuses to start with a live Stripe key in
that mode.

Both money paths are single conditional statements, so replicas cannot
interleave a check with its write:

- `applyLedgerEntry` — insert-if-`ref`-absent **and** balance-stays-non-negative.
- `claimOperation` — `INSERT ... ON CONFLICT (ref) DO NOTHING`: exactly one
  caller performs the effect, every retry replays that operation's outcome.

## Scope of this build

- Without `DATABASE_URL`, storage is in-memory: credits, top-ups, clients,
  codes, nonces, operations and session ownership do not survive a restart,
  and the service refuses to start that way with a live Stripe key.
- Losing the browser device key means losing access to that balance; there is
  deliberately no recovery path, because there is no account to recover.
- There is no Popcorn dashboard yet — balance and top-ups are MCP tools plus
  the hosted Stripe Checkout page.
