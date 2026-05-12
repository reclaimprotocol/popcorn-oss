# [CRITICAL] Restricted API users can execute arbitrary Node.js code in the browser pod

**File:** [`popcorn-images/server/runtime/playwright-daemon.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/server/runtime/playwright-daemon.ts#L106-L159) (lines 106, 107, 151, 152, 158, 159)
**Project:** popcorn
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `rce`

## Finding

The daemon accepts caller-supplied `code` from its JSON protocol and runs it with `new AsyncFunction`, passing Playwright objects but not sandboxing the function. This code runs in the daemon's Node.js process, not inside a browser-only context, so it can access globals such as `process`, use dynamic imports like `node:fs` or `node:child_process`, read mounted service-account tokens/secrets, and execute OS commands. The handler is reached through the Kernel API `/playwright/execute`, which is exposed by the gateway `/api/<session>/<restricted-token>/...` route with only restricted-token auth. That turns a restricted session API token into remote code execution inside the browser-runtime container and can also reach local full-CDP endpoints or Kubernetes/GCP credentials available to the pod.

## Recommendation

Do not evaluate arbitrary client code in the daemon process. Replace this with a constrained automation API or run code in a hardened sandbox/container with no Node globals, no filesystem/process/network access, strict resource limits, and a separate internal/admin-only authorization scope. If arbitrary process execution is intentional, remove it from the restricted client-facing API surface.
