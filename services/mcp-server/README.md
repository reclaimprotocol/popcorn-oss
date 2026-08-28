# mcp-server

A remote **Model Context Protocol** server that lets any MCP client (Claude,
Cursor, agent marketplaces) start isolated Popcorn browser sessions and pay for
them with a card — no wallet, no private keys, no `402` handshake.

## Design

- **MCP-native OAuth 2.1 + PKCE.** Clients register dynamically, the human
  approves once in a browser, and the access token carries a stable
  pseudonymous subject.
- **Email OTP, no sign-up.** Authentication is a 6-digit code emailed via AWS
  SES from `noreply@reclaimprotocol.org`. Proving control of an address *is*
  the account: no password, no registration step, and the MCP client never
  learns the address. The auth header identifies *whose* balance and policy
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
GET  /oauth/authorize       sign-in + consent (PKCE S256 required)
POST /oauth/email           send the 6-digit code by SES
POST /oauth/decision        verify the code, approve, redirect with auth code
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
| `OTP_FROM_ADDRESS` | `noreply@reclaimprotocol.org` | Must be a verified SES identity |
| `AWS_REGION` | `us-east-1` | SES region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | – | Optional static keys; otherwise IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` exchanged via `sts:AssumeRoleWithWebIdentity`) or the ECS/EKS container credential endpoint |
| `MCP_OTP_MAX_PER_WINDOW` | `5` | Codes per address per 15 minutes |
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

- Storage is in-memory (`src/store.ts` defines the interface). Operators
  running more than one replica should back it with Postgres/Redis before
  taking real payments.
- OTP challenges live in the same in-memory store as everything else, so a
  code issued by one replica cannot be redeemed by another until a shared store
  is wired in.
- SES must have `OTP_FROM_ADDRESS` verified and be out of the sandbox.
