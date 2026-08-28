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
- **Idempotent money.** Credits are keyed on the Stripe event, debits on an
  `idempotency_key`, and a failed allocation is refunded automatically.

## Tools

| Tool | Paid | Purpose |
| --- | --- | --- |
| `get_balance` | – | Balance, session price, how many sessions it buys |
| `top_up` | – | Stripe Checkout URL for the human to approve |
| `create_browser_session` | ✓ | Isolated session: id, live-view URL, CDP URL, expiry, amount charged |
| `get_browser_session` | – | State of a session the caller owns |
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
| `MCP_TOKEN_SIGNING_KEY` | dev key | **Set in production**; signs access tokens |
| `MCP_SESSION_PRICE_USD_CENTS` | `5` | Price of one session |
| `MCP_SESSION_TTL_SECONDS` | `600` | Default session lifetime |
| `MCP_MIN_TOP_UP_USD_CENTS` | `500` | Minimum card charge |
| `OTP_FROM_ADDRESS` | `noreply@reclaimprotocol.org` | Must be a verified SES identity |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | – | SES credentials (IRSA works) |
| `MCP_OTP_MAX_PER_WINDOW` | `5` | Codes per address per 15 minutes |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | – | Required for `top_up` |
| `MCP_TOP_UP_SUCCESS_URL` / `MCP_TOP_UP_CANCEL_URL` | – | Checkout return URLs |

## Run

```bash
bun install
bun run dev
bun test
```

## Scope of this build

- Storage is in-memory (`src/store.ts` defines the interface). Operators
  running more than one replica should back it with Postgres/Redis before
  taking real payments.
- OTP challenges live in the same in-memory store as everything else, so a
  code issued by one replica cannot be redeemed by another until a shared store
  is wired in.
- SES must have `OTP_FROM_ADDRESS` verified and be out of the sandbox.
