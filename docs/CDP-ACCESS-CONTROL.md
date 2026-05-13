# CDP Access Control Guide

Popcorn provides **two separate CDP (Chrome DevTools Protocol) endpoints** with different access levels, controlled by JWT token scopes.

## Overview

| Endpoint | Port | Token Scope | Access Level | Use Case |
|----------|------|-------------|--------------|----------|
| `/cdp/` | 9222 | `restricted` | **Full** (for now) → Will be restricted | Client applications |
| `/cdp-internal/` | 9224 | `internal` | **Full** (always) | Internal services & debugging |

## Session Creation

When you create a session, you receive **two CDP URLs** with different tokens:

The `/session` API requires control-plane-backed client credentials.

### Request
```bash
curl -X POST http://popcorn-gateway/session \
  -H "Authorization: Bearer <client-id>:<client-secret>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "my-session"}'
```

### Response
```json
{
  "success": true,
  "sessionId": "my-session",
  "url": "http://popcorn-gateway/browser-fleet-abc-xyz/my-session/{token}/",
  "cdpUrl": "ws://popcorn-gateway/cdp/my-session/{restricted-token}/",
  "cdpInternalUrl": "ws://popcorn-gateway/cdp-internal/my-session/{internal-token}/",
  "apiUrl": "http://popcorn-gateway/api/my-session/{token}/",
  "browserPodId": "browser-fleet-abc-xyz"
}
```

**Important:** Each URL has a different JWT token with different scopes:
- `cdpUrl` → Token with `scope: "restricted"`
- `cdpInternalUrl` → Token with `scope: "internal"`

## Connecting to CDP

### Option 1: Client Access (Restricted Endpoint)

For client-facing applications that should have limited access:

```javascript
const session = await fetch('http://popcorn-gateway/session', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <client-id>:<client-secret>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ sessionId: 'client-session' })
}).then(r => r.json());

// Connect using cdpUrl (restricted endpoint)
const browser = await playwright.chromium.connectOverCDP(session.cdpUrl);
```

**Status:**
- **Currently:** All CDP commands allowed
- **Future:** Only whitelisted commands allowed (safe operations)

### Option 2: Internal Access (Full Endpoint)

For internal services, debugging tools, or administrative operations:

```javascript
const session = await fetch('http://popcorn-gateway/session', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <client-id>:<client-secret>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ sessionId: 'internal-session' })
}).then(r => r.json());

// Connect using cdpInternalUrl (full access endpoint)
const browser = await playwright.chromium.connectOverCDP(session.cdpInternalUrl);
```

**Status:**
- Always has **full unrestricted** CDP access
- All CDP commands are allowed

## Examples

### Playwright (TypeScript/JavaScript)

```typescript
import { chromium } from 'playwright';

// Get session
const response = await fetch('http://popcorn-gateway/session', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <client-id>:<client-secret>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ sessionId: `session-${Date.now()}` })
});
const session = await response.json();

// For internal use - full access
const browser = await chromium.connectOverCDP(session.cdpInternalUrl);
const context = browser.contexts()[0];
const page = context.pages()[0];

// All CDP commands work
await page.goto('https://example.com');
await browser.close(); // ✅ Works on internal endpoint
```

### Puppeteer

```javascript
const puppeteer = require('puppeteer');

// Get session
const session = await fetch('http://popcorn-gateway/session', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <client-id>:<client-secret>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ sessionId: 'my-session' })
}).then(r => r.json());

// Connect to internal endpoint for full access
const browser = await puppeteer.connect({
  browserWSEndpoint: session.cdpInternalUrl
});

const page = await browser.newPage();
await page.goto('https://example.com');
```

### Direct CDP (Chrome DevTools Protocol)

```javascript
const WebSocket = require('ws');

// Get session
const session = await fetch('http://popcorn-gateway/session', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <client-id>:<client-secret>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ sessionId: 'cdp-session' })
}).then(r => r.json());

// Connect to internal endpoint
const ws = new WebSocket(session.cdpInternalUrl);

ws.on('open', () => {
  // Send CDP command
  ws.send(JSON.stringify({
    id: 1,
    method: 'Browser.getVersion',
    params: {}
  }));
});

ws.on('message', (data) => {
  const response = JSON.parse(data);
  console.log('CDP Response:', response);
});
```

## Security Model

### Token Scope Validation

The gateway validates JWT token scopes before routing:

- **`/cdp/` endpoint**: Requires token with `scope: "restricted"`
- **`/cdp-internal/` endpoint**: Requires token with `scope: "internal"`

Attempting to use the wrong token on an endpoint results in **403 Forbidden**:

```javascript
// ❌ This will fail - restricted token on internal endpoint
const ws = new WebSocket(session.cdpInternalUrl.replace(internalToken, restrictedToken));
// Error: 403 Forbidden - Insufficient scope
```

### Command Filtering (Future)

When enabled, the restricted endpoint (`/cdp/`) will filter CDP commands:

**Allowed Commands (Whitelist):**
- `Page.*` - Page navigation, screenshots, etc.
- `Runtime.*` - JavaScript evaluation
- `DOM.*` - DOM manipulation
- `Input.*` - Mouse/keyboard input
- `Network.*` - Network inspection
- `Target.*` - Target management
- `Emulation.*` - Device emulation
- `Console.*` - Console messages
- `Log.*` - Logging

**Blocked Commands:**
- `Browser.close` - Cannot close the browser
- `Browser.*` - Other browser-level operations
- `ServiceWorker.*` - Service worker operations
- `Debugger.*` - Debugging protocol

Blocked commands return:
```json
{
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Command not allowed"
  }
}
```

## Migration Guide

### For Client Applications

**No changes needed now.** Continue using `cdpUrl` as before. Your code will keep working.

### For Internal Services

**Recommended:** Update to use `cdpInternalUrl` to ensure full access in the future:

```diff
  const session = await createSession();
- const browser = await chromium.connectOverCDP(session.cdpUrl);
+ const browser = await chromium.connectOverCDP(session.cdpInternalUrl);
```

## Troubleshooting

### Error: 403 Forbidden - Insufficient scope

**Cause:** Wrong token scope for the endpoint

**Solution:**
- Use `cdpUrl` (restricted token) for `/cdp/` endpoint
- Use `cdpInternalUrl` (internal token) for `/cdp-internal/` endpoint

### Error: 404 Not Found

**Cause:** No CDP route found in Redis

**Solution:**
- Ensure the session is created successfully
- Check that the GameServer is allocated and running
- Verify Redis contains `route:cdp-internal:{sessionId}` key

### Error: Command not allowed (Future)

**Cause:** Command is blocked on restricted endpoint

**Solution:**
- Switch to `cdpInternalUrl` for full access
- Or use only whitelisted commands on restricted endpoint

## Architecture

### Request Flow

```
Client/Service
    ↓
POST /session → Pool Manager
    ↓
Generate 2 JWT tokens:
  - scope: "restricted"  → cdpUrl
  - scope: "internal"    → cdpInternalUrl
    ↓
Client connects to chosen endpoint
    ↓
Gateway validates token scope
    ↓
Routes to Browser Pod:
  - /cdp/ → Port 9222
  - /cdp-internal/ → Port 9224
    ↓
CDP Proxy → Chrome DevTools
```

### Components

| Component | Responsibility |
|-----------|----------------|
| **Pool Manager** | Generates dual tokens, stores routes in Redis |
| **Gateway** | Validates JWT scope, routes to correct port |
| **Browser Pod (9222)** | CDP proxy (will be filtered) |
| **Browser Pod (9224)** | CDP proxy (full access) |
| **Redis** | Stores session → IP:Port mappings |

## Best Practices

### 1. Use Internal Endpoint for Automation

For internal services that need full control:

```javascript
// ✅ Good - Full access for internal tools
const browser = await chromium.connectOverCDP(session.cdpInternalUrl);
```

### 2. Use Restricted Endpoint for Client Apps

For user-facing applications (when filtering is enabled):

```javascript
// ✅ Good - Safe operations only
const browser = await chromium.connectOverCDP(session.cdpUrl);
```

### 3. Store Tokens Securely

Never expose internal tokens to clients:

```javascript
// ❌ Bad - Don't send internal token to frontend
res.json({ cdpUrl: session.cdpInternalUrl });

// ✅ Good - Only send restricted token to frontend
res.json({ cdpUrl: session.cdpUrl });
```

### 4. Clean Up Sessions

Always delete sessions when done:

```javascript
await fetch(`http://popcorn-gateway/session/${sessionId}`, {
  method: 'DELETE',
  headers: {
    Authorization: 'Bearer <client-id>:<client-secret>'
  }
});
```

## FAQ

**Q: When will the restricted endpoint start filtering commands?**
A: TBD - we'll announce before enabling filtering. For now, both endpoints allow all commands.

**Q: Can I use the same token on both endpoints?**
A: No. Each endpoint requires its own token with the correct scope.

**Q: What happens if I use a restricted token on the internal endpoint?**
A: You'll get a `403 Forbidden` error with message "Insufficient scope".

**Q: Is the internal endpoint less secure?**
A: No - it still requires a valid JWT token with the correct scope. Only authorized internal services can access it.

**Q: Can I enable filtering on the restricted endpoint now?**
A: Yes - update `main.go` line 207 to use `WebSocketProxyHandlerFiltered` instead of `WebSocketProxyHandler`, rebuild, and redeploy.

## References

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Playwright CDP Mode](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Puppeteer connect()](https://pptr.dev/api/puppeteer.puppeteer.connect)
