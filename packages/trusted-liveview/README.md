# LiveView E2E transport

Both transport modes use `images/minimal-vnc-desktop/viewer.js`. They share the
noVNC UI, keyboard and IME code, touch handling, quality controls, diagnostics,
and reconnect logic.

The default viewer URL uses the standard transport. Set `?encryption=e2e` to
use E2E.

## Starting an encrypted session

Create the session with `liveViewEncryption: 'e2e'`, then open the returned
`url`. The URL fragment contains the one-time bootstrap data and stays
client-side.

The viewer generates an X25519 keypair and stores it with the bootstrap data in
same-origin `localStorage`. It removes the fragment after the write succeeds.
A reload uses the viewer route to recover the same record. A new allocation
gets a new key even if it reuses an earlier `sessionId`.

Native shells and custom hosts can install the transport directly:

```js
import {
  createLiveViewSessionKey,
  installUnifiedLiveViewE2E,
} from '@popcorn/trusted-liveview';

const response = await createSession({
  sessionId: 'demo',
  regions: ['local'],
  liveViewEncryption: 'e2e',
});
const key = await createLiveViewSessionKey();

installUnifiedLiveViewE2E(response, key, window);
// Load the same liveview.html used by the default mode with
// `?encryption=e2e` appended to its viewer options.
```

`installUnifiedLiveViewE2E` installs a transport factory in the existing viewer
and noVNC instance. The viewer opens the RFB and control Noise channels in
parallel. It sends keyboard, touch, emulation, geometry, diagnostics, and RTT
messages through the encrypted control channel.

With `encryption=e2e`, missing or invalid metadata stops the connection. The
viewer fails closed in E2E mode. The default viewer URL continues to use the
standard transport.

The private key is a raw 32-byte X25519 scalar encoded as base64url. The standard
browser flow stores it as plaintext in `localStorage` for reconnects, where
same-origin scripts can read it. A native host should use its platform key
store. Keep the private key in the viewer's reconnect storage or the native
platform key store.

The create response releases `liveViewE2e.bindingSecret` once. Status and TTL
responses return persistent session metadata. The viewer sends the secret
inside the encrypted Noise IK payload, where the pod uses it to bind the first
client public key. Keep the secret in the create-response fragment and
encrypted enrollment payload.

Production E2E endpoints must use `wss://`. The bootstrap accepts `ws://` only
when the viewer and endpoint both use loopback addresses.

E2E responses include `cdpUrl` and `cdpInternalUrl` for Playwright and other
server-side automation. Authenticated WSS protects these connections in transit.
The gateway and the server running the automation process their payloads and
can inspect browser state.
