# Local quickstart

This path creates a disposable Kind cluster, builds the OSS images, installs
Agones and Popcorn, and creates one browser session. It is an evaluation path,
not a production topology.

## 1. Install local tools

You need Docker, Kind, kubectl, Helm 3, Make, OpenSSL, and jq. Docker must have
enough memory and disk to build and run a Chromium image.

```bash
git clone https://github.com/reclaimprotocol/popcorn-oss.git
cd popcorn-oss
```

## 2. Build and start Popcorn

```bash
make local-keys
make run-local-cluster
```

The first command creates development-only gateway JWT keys. The second builds
images, creates the `popcorn` Kind cluster, installs Agones, creates local
Secrets, deploys both charts, and waits for the core workloads.

The local endpoints are:

```text
Gateway:       http://localhost:8080
Control plane: http://localhost:8081
```

## 3. Check the installation

```bash
kubectl get nodes
kubectl get pods
kubectl get fleet,fleetautoscaler,gameservers
curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8081/health
```

Wait until a GameServer is `Ready` before creating a session:

```bash
kubectl get gameservers --watch
```

## 4. Create client credentials

The local admin token is intentionally predictable and must never be used in a
real deployment.

```bash
export CONTROL_PLANE_URL=http://localhost:8081
export CONTROL_PLANE_ADMIN_TOKEN=local_admin_token_for_dev

CLIENT_JSON=$(curl -fsS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"local quickstart","allowedClusters":["local"]}')

export POPCORN_CLIENT_ID=$(printf '%s' "$CLIENT_JSON" | jq -r .clientId)
export POPCORN_CLIENT_SECRET=$(printf '%s' "$CLIENT_JSON" | jq -r .clientSecret)
```

## 5. Create a browser session

```bash
SESSION_JSON=$(curl -fsS -X POST "$CONTROL_PLANE_URL/v1/sessions" \
  -H "Authorization: Bearer $POPCORN_CLIENT_ID:$POPCORN_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"local-quickstart","regions":["local"]}')

printf '%s\n' "$SESSION_JSON" | jq
```

Open the returned `url`. It is the built-in LiveView page. The response also
contains `cdpUrl` for client automation and `cdpInternalUrl` for trusted
full-CDP automation.

All session URLs contain bearer credentials. Do not paste real production URLs
into logs, issue trackers, or screenshots.

## 6. Optional CDP smoke test

Install Playwright in a separate test project, then run:

```javascript
import { chromium } from "playwright";

const response = await fetch("http://localhost:8081/v1/sessions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.POPCORN_CLIENT_ID}:${process.env.POPCORN_CLIENT_SECRET}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sessionId: `pw-${Date.now()}`, regions: ["local"] }),
});
if (!response.ok) throw new Error(await response.text());

const session = await response.json();
const browser = await chromium.connectOverCDP(session.cdpUrl);
const context = browser.contexts()[0] ?? await browser.newContext();
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

## 7. Stop or reset

Delete only the test session:

```bash
curl -fsS -X DELETE "$CONTROL_PLANE_URL/v1/session/local-quickstart" \
  -H "Authorization: Bearer $POPCORN_CLIENT_ID:$POPCORN_CLIENT_SECRET"
```

Delete the whole local cluster:

```bash
make clean
```

The reset removes the Kind cluster but leaves locally built Docker images.

## Next steps

- Read [Architecture](architecture.md) to understand what the quickstart ran.
- Read [Requirements and planning](prerequisites.md) before creating a
  production cluster.
- Use [Troubleshooting](troubleshooting.md) if the Fleet has no Ready
  GameServers or session creation fails.
