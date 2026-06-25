# Quickstart

Use this path to prove Popcorn works on one machine. It builds local images,
creates development Secrets, deploys to Kind, and exposes local ports.

## Prerequisites

Install these on your local machine before starting:

- Docker Engine or Docker Desktop, running locally, with BuildKit enabled.
- Kind.
- kubectl.
- Helm 3.
- Make.
- jq, used by the copy-paste commands below to extract JSON fields.

The quickstart creates a local Kind cluster and publishes the gateway and
control-plane ports during setup. You do not need a separate connect or tunnel
step for the default local flow.

Clone with submodules:

```bash
git clone --recursive https://github.com/reclaimprotocol/popcorn-oss.git
cd popcorn-oss
```

If the repo was already cloned:

```bash
git submodule update --init --recursive
```

## Start Popcorn

```bash
make local-keys
make run-local-cluster
```

What these commands do:

- `make local-keys` generates local-only JWT key files used to sign and verify
  browser, CDP, and runtime API URLs.
- `make run-local-cluster` builds the local service images, creates or reuses
  the Kind cluster, installs local development Secrets, installs Agones,
  deploys Popcorn, and exposes the local gateway and control plane ports.

Expected local endpoints:

```text
Gateway:       http://localhost:8080
Control plane: http://localhost:8081
```

Check health:

```bash
curl -sS http://localhost:8080/health
curl -sS http://localhost:8081/health
```

## Create A Session

Popcorn separates client identity from browser runtime:

- A client is an application or user integration that is allowed to request
  browser sessions. The control plane gives it a `clientId` and `clientSecret`.
- A session is one allocated browser instance. When you create a session,
  Popcorn asks the pool manager for a browser pod and returns signed URLs for
  the browser view, CDP, and runtime API.

Create a local client and export the returned credentials:

```bash
CONTROL_PLANE_URL=http://localhost:8081
CONTROL_PLANE_ADMIN_TOKEN=local_admin_token_for_dev

CLIENT_JSON=$(curl -sS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"local demo"}')

export POPCORN_CLIENT_ID=$(printf '%s' "$CLIENT_JSON" | jq -r .clientId)
export POPCORN_CLIENT_SECRET=$(printf '%s' "$CLIENT_JSON" | jq -r .clientSecret)
```

Use those credentials to create a browser session:

```bash
curl -sS -X POST "$CONTROL_PLANE_URL/v1/sessions" \
  -H "Authorization: Bearer $POPCORN_CLIENT_ID:$POPCORN_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"local-demo","regions":["local"]}'
```

Open the returned `url` for the browser view, or connect automation to
`cdpUrl`.

When the local cluster is run with `LOCAL_BROWSER_STREAMING_MODE=vnc`, the
Makefile builds and deploys `popcorn/minimal-vnc-desktop:local`. The response
still uses the compatibility field names `url`, `vncUrl`, and `vncWsUrl`, but
their values point at the LiveView routes:

```text
url/vncUrl:   http://localhost:8080/liveview/<sessionId>/<token>/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000
vncWsUrl:     ws://localhost:8080/liveview-ws/<sessionId>/<token>
```

The `vncUrl` and `vncWsUrl` names are kept for API compatibility. New UIs should
display this as LiveView.

## Playwright Smoke Test

```js
import { chromium } from "playwright";

const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? "http://localhost:8081";
const clientId = process.env.POPCORN_CLIENT_ID;
const clientSecret = process.env.POPCORN_CLIENT_SECRET;

const session = await fetch(`${controlPlaneUrl}/v1/sessions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${clientId}:${clientSecret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sessionId: `pw-${Date.now()}`, regions: ["local"] }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(session.cdpUrl);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

## Local Networking Notes

Kind is same-machine only by default. The local setup publishes a small UDP
range and advertises `127.0.0.1` for WebRTC. Use TURN for realistic browser
access from another device, a VPN, a cloud cluster, or a network that blocks
direct UDP.

## Reset

```bash
make clean
```

This deletes the Kind cluster. It does not remove Docker images.
