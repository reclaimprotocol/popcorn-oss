# Viewer handoff

Viewer handoff removes interactive access to an allocated browser without closing its authenticated tabs.
The trusted CDP connection remains available for server-side work.
Handoff is irreversible for that allocation.

This feature only controls viewer access. The caller controls subsequent server-side work.
The caller must finish the interactive flow and stop existing automation before handoff.
Handoff does not extend the session deadline.

Handoff is a server-side viewer disconnection. It does not create or move a browser session.
Unlike a normal viewer disconnection, handoff also blocks reconnect attempts and preserves the current viewport and mobile emulation.

## Client contract

The session owner calls the credentialed API:

```http
POST /v1/session/:id/handoff
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json

{"expectedPodUid":"<current-pod-uid>"}
```

The expected pod UID identifies the allocation, not only the public session ID.
The current create or fetch response provides that value in `podUid`.
A stale pod UID cannot revoke a replacement allocation under the same session ID.
Another client cannot hand off a session that it does not own.
The control plane also checks the stored `sessionBoundAt` before and after the runtime acknowledgement.
A missing or changed binding returns `409`, including reallocation within the same region and cluster.

A successful response includes `viewerAccess: "revoked"` and `runtimeInstanceId`.
The runtime instance identifies the process that acknowledged handoff.
The pool manager requires a version 1 runtime response with the exact session ID and pod UID.
An unavailable or older runtime does not produce a successful acknowledgement.
The pool manager checks runtime support before it records the handoff annotation.

The credentialed handoff API rejects sessions with an `automation` CDP scope.
That scope uses the trusted CDP port, so viewer revocation cannot separate it from the background worker.
The first implementation supports sessions with the `restricted` CDP scope.

The response establishes a runtime forwarding boundary.
It does not undo input that already reached Chromium, Xvnc, or a browser extension.
It does not establish that existing page timers or asynchronous account actions stopped.

## Runtime behavior

The pool manager records `popcorn.dev/viewer-handoff` on the current GameServer.
Its value is the current pod UID.
The runtime reads that annotation through the local Agones SDK.

After handoff, the runtime rejects viewer connections and reconnect attempts.
The runtime closes existing viewer connections and the client side of restricted CDP connections.
The trusted CDP endpoint remains separate from viewer access.
The browser process, tabs, cookies, and browser storage remain in place.

The runtime retains existing upstream CDP connections that own mobile emulation.
Those connections discard incoming browser events and cannot send new browser commands or reconnect after connection loss.
This preserves the observed viewport, device scale, and touch support during handoff.
Normal restricted-CDP disconnection still closes its upstream connection.

The runtime exposes a read-only status endpoint:

```http
GET /_popcorn/viewer-handoff-status
Cache-Control: no-store
```

```json
{
  "version": 1,
  "state": "revoked",
  "sessionId": "example-session",
  "podUid": "example-pod-uid",
  "runtimeInstanceId": "<runtime-instance>"
}
```

The endpoint does not expose connection URLs, credentials, or page contents.
It does not accept a client request to change the annotation.

| State | Meaning |
| --- | --- |
| `awaiting_binding` | The runtime has no usable allocation binding. |
| `active` | The current allocation permits viewer access. |
| `revoking` | The runtime has not completed handoff. |
| `revoked` | The runtime acknowledged handoff for the stated allocation. |
| `unconfirmed` | The runtime cannot establish a successful handoff. |

An in-memory flag alone cannot restore viewer access after a process restart.
The durable allocation annotation remains the source for the handoff decision.
An unavailable allocation store cannot establish fresh viewer access.

A runtime restart changes `runtimeInstanceId` and closes CDP connections owned by that process.
The browser can retain authentication while mobile emulation changes after those connections close.
A caller cannot reuse a receipt or a browser-state baseline from the previous runtime process.
The caller needs a fresh acknowledgement and a fresh baseline before server-side work continues.

## Caller failure rules

1. Wait for an acknowledgement with the expected session ID and pod UID.
2. If handoff is unconfirmed, do not start server-side work that requires exclusive viewer control.
3. Retry only within a bounded deadline and with the same expected pod UID.
4. If handoff remains unconfirmed, use the allocation-fenced termination endpoint described next.
5. Keep the existing session deadline unless a separate authorized operation extends it.

Handoff does not revoke unrelated server credentials or stop another trusted CDP client.
The caller still owns coordination between trusted automation tools.

## Allocation-fenced termination

The maintenance caller uses a separate endpoint after handoff or an unsuccessful handoff attempt:

```http
DELETE /v1/session/:id/allocation
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json

{"expectedPodUid":"<current-pod-uid>"}
```

The successful response is:

```json
{
  "success": true,
  "sessionId": "example-session",
  "podUid": "example-pod-uid",
  "shutdownAcknowledged": true,
  "allocationReleased": true
}
```

The control plane checks the authenticated owner and its current allocation timestamp.
The pool manager checks that owner, timestamp, and pod UID against its current session record.
It checks the Pod controller reference, GameServer UID, `Allocated` state, and session annotations.
Kubernetes receives a GameServer deletion with both UID and resource-version preconditions.
A recreated GameServer or changed binding cannot satisfy those preconditions.

The protected object is the GameServer allocation, not an individual physical Pod.
A replacement Pod under the same unchanged GameServer allocation remains part of that allocation.
The response repeats the requested pod UID for correlation.
`shutdownAcknowledged` means that Kubernetes accepted deletion of the checked allocation.
It does not mean that the physical Pod, Chromium process, or all previously started actions have stopped.

`allocationReleased` also requires deletion of matching Redis session and route records.
Redis performs each deletion atomically against the complete expected session record.
A configured secondary Redis requires the same check and acknowledgement.
Secondary cleanup precedes primary deletion, so a secondary failure or binding conflict preserves the authoritative primary record.
The final primary deletion checks the binding again. Cleanup across both stores is not one atomic operation.
The control plane ends its session record only when the owner and allocation timestamp still match.
These checks never delete a replacement record.
They do not add a global lock to existing session writers.

The operation rejects changed ownership or binding, missing allocation evidence, and incomplete cleanup.
A timeout can occur after Kubernetes accepts deletion but before database cleanup completes.
Such a response remains unconfirmed, even when the original allocation later disappears.
The existing TTL controller remains a separate cleanup backstop for expired `Allocated` GameServers.
TTL is not evidence that immediate shutdown succeeded, and it does not guarantee cleanup of every controller failure.

Caller rules:

1. Require the exact successful response and the expected session ID and pod UID.
2. If the response is missing, stale, or unconfirmed, record cleanup as unconfirmed.
3. Close the caller-owned CDP connection within its cleanup deadline.
4. Never retry through the legacy `DELETE /v1/session/:id` endpoint.
5. Never replace the expected pod UID with a later allocation UID to finish an earlier operation.

The control-plane deadline is nine seconds. The pool-manager deadline is seven seconds.
Retries can return a conflict or not-found response after a previous deletion succeeds.
The endpoint does not claim idempotent success without current allocation evidence.

The internal endpoint is `DELETE /internal/session/:id/allocation` with service authentication.
Its body contains `clientId`, `expectedPodUid`, and the control-plane-owned `expectedBoundAt` timestamp.
Its response also includes `boundAt` for the control-plane check.

An older server returns 404 for the separate endpoint without invoking legacy deletion.
Adding an optional UID body to the legacy endpoint is unsafe because older servers ignore that body.
The legacy deletion contract remains unchanged.
The regional handoff and termination clients reject redirects and limit acknowledgement bodies to 4 KiB.

## Deployment compatibility

The control plane, pool manager, and browser runtime require compatible releases.
The browser runtime has a separate image from the service images.
An update to the control plane alone does not add handoff support to existing browser pods.

The old pool manager can publish different binding timestamps during one encrypted allocation.
The new runtime treats a changed binding timestamp as an allocation conflict and closes viewer access.
The new pool manager uses one binding timestamp throughout allocation.

Deployment order:

1. Complete the pool-manager update in every relevant region.
2. Complete the control-plane update.
3. Update the browser runtime image and the browser fleet.
4. Keep the new pool manager while browser pods use the new runtime.

Missing status support, an invalid acknowledgement, or a different allocation must prevent a successful handoff response.
The caller must not replace that response with a UI-only hide operation.
The API caller controls when to request handoff.

## Local tests

The process test requires Go, cached Go dependencies, Node 22 or later, and a local Chromium executable.
If a required executable is missing, the test fails. It does not silently skip.
The recorded local run used Go 1.27.0, Node 24.16.0, and Chromium 142.0.7444.175.

From `images/minimal-vnc-desktop`, run:

```sh
POPCORN_HANDOFF_TEST_CHROME=/absolute/path/to/chrome \
  node --test scripts/viewer-handoff-test.mjs
```

The test builds the proxy with external Go dependency access disabled.
It starts the actual proxy and Chromium processes on loopback addresses.
It uses a synthetic website, synthetic authentication, a fake Agones SDK, and a fake RFB upstream.

The process test covers:

- Viewer and restricted CDP access before handoff.
- A viewer input event that reaches the actual authenticated page before handoff.
- Existing connection closure and rejected reconnect attempts after handoff.
- The same authenticated tab and trusted CDP access after handoff.
- Mobile viewport, device scale, and touch support before and after handoff.
- A runtime restart with the durable handoff annotation.
- Rejected viewer access after a restart without an available allocation store.
- A bounded status response without connection URLs.

The test runs two fresh sessions with different owners for the mobile overrides.
One session uses `/emulate`. The other session uses a restricted CDP connection.

The Go tests cover the runtime protocol and concurrent connection behavior.
The Bun tests cover the service contracts and caller authorization.

Allocation termination tests cover recreated GameServers, changed bindings, owner mismatches, and replacement metadata during shutdown.
Route tests cover authentication, the exact acknowledgement, legacy behavior, and an older server without the allocation endpoint.
Local HTTP tests reject 307 and 308 redirects without a request to the legacy delete endpoint.
A SQL-construction test checks the atomic owner, state, and binding predicate. It does not use PostgreSQL.
The optional Redis test starts a private temporary Redis process and checks the production Lua deletion against replacement records.
It never uses application database credentials.

From `services/pool-manager`, run the Redis test with an explicit local executable:

```sh
POPCORN_TEST_REDIS_SERVER=/absolute/path/to/redis-server \
  bun test src/services/session-termination-redis.test.ts
```

The Redis test skips when neither an explicit executable nor `redis-server` on `PATH` exists.
The recorded local run used Redis 7.0.15 and passed all three allocation-cleanup tests.

These local tests do not run a Kubernetes cluster, the public gateway, Xvnc, or the browser extension.
They do not establish that previously delivered input has no later effect.
A deployed acceptance test must cover those integration boundaries before production callers rely on the acknowledgement.
