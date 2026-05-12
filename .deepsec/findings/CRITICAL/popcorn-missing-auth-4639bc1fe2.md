# [CRITICAL] Kernel API exposes command execution without service-layer authentication

**File:** [`popcorn-images/server/cmd/api/main.go`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/server/cmd/api/main.go#L117-L174) (lines 117, 118, 137, 141, 173, 174)
**Project:** popcorn
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Finding

main.go registers the generated OpenAPI handler directly with no auth middleware and listens on all interfaces for the primary API. The registered routes include sensitive operations such as /process/exec, /process/spawn, /playwright/execute, and /fs/*; traced code in api/process.go builds exec.Command from request-controlled command and args and can run as root when requested. Gateway JWT checks do not wrap this handler directly, so any peer that can reach the pod/local port can bypass the gateway and execute commands or read/write files in the browser runtime.

## Recommendation

Add authentication and authorization middleware directly to the API router before registering handlers, such as validating the session JWT or a gateway-injected HMAC/header secret. Also restrict network reachability with NetworkPolicy and isolate these ports from browser-rendered web content; treat CORS/content-type checks only as defense in depth.
